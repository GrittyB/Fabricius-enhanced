/* eslint-disable max-len */
/* eslint-disable no-multi-str */

import {AugmentedBlock, Block, BlockWithNote} from './types';
import {
  batchFindNotes,
  updateNote,
  batchAddNotes,
  invokeAnkiConnect,
  batchDeleteNotes,
} from './anki';
import {config} from './config';
import {
  convertToCloze,
  pullBlocksUnderTag,
  pullBlocksWithTag,
  parseBasicFlashcard,
} from './roam';
import {render} from './toast';
import {Intent} from '@blueprintjs/core';

// Core sync logic
const syncNow = async (extensionAPI: any) => {
  console.log('[syncNow] started');

  // STEP 0: Load all config
  const allSettings = await extensionAPI.settings.getAll();
  console.log(
    'settings before merging defaults: ' + JSON.stringify(allSettings)
  );
  const groupTag = await getOrDefault(
    extensionAPI.settings.get(config.GROUPED_CLOZE_TAG_KEY),
    config.GROUPED_CLOZE_TAG
  );
  const titleTag = await getOrDefault(
    extensionAPI.settings.get(config.TITLE_CLOZE_TAG_KEY),
    config.TITLE_CLOZE_TAG
  );
  const deck = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_DECK_NAME_KEY),
    config.ANKI_DECK_NAME
  );
  const model = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_MODEL_NAME_KEY),
    config.ANKI_MODEL_NAME
  );
  const basicModel = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_BASIC_MODEL_NAME_KEY),
    config.ANKI_BASIC_MODEL_NAME
  );
  const clozeField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_CLOZE_TEXT_KEY),
    config.ANKI_FIELD_FOR_CLOZE_TEXT
  );
  const titleField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_TITLE_KEY),
    config.ANKI_FIELD_FOR_TITLE
  );
  const groupHeaderField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_GROUP_HEADER_KEY),
    config.ANKI_FIELD_FOR_GROUP_HEADER
  );
  const metadataField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_METADATA_KEY),
    config.ANKI_FIELD_FOR_METADATA
  );
  const frontField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_FRONT_KEY),
    config.ANKI_FIELD_FOR_FRONT
  );
  const backField = await getOrDefault(
    extensionAPI.settings.get(config.ANKI_FIELD_FOR_BACK_KEY),
    config.ANKI_FIELD_FOR_BACK
  );

  console.log(
    'settings after merging defaults - clozeField:' +
      clozeField +
      ', metadataField:' +
      metadataField +
      ', groupHeaderField:' +
      groupHeaderField +
      ', groupTag:' +
      groupTag +
      ', titleField:' +
      titleField +
      ', titleTag:' +
      titleTag +
      ', deck:' +
      deck +
      ', model:' +
      model +
      ', basicModel:' +
      basicModel +
      ', frontField:' +
      frontField +
      ', backField:' +
      backField
  );

  // STEP 1: Roam 查询函数拿到三类 block：单独 cloze、basic、grouped cloze 子块。

  // 在 Roam 页面顶部弹出一条提示，告知用户「开始同步」。
  render({
    id: 'syncer',
    content: 'Fabricius: starting sync',
    intent: Intent.SUCCESS,
  });

  // 查询所有含 #srs/cloze（CLOZE_TAG）的块。

  const singleBlocks: AugmentedBlock[] = await retry(
    () => pullBlocksWithTag(config.CLOZE_TAG), // TODO: not using settings panel
    config.ANKI_CONNECT_RETRIES
  );
  // Get basic flashcard blocks
  const basicBlocks: AugmentedBlock[] = await retry(
    () => pullBlocksWithTag(config.BASIC_TAG),
    config.ANKI_CONNECT_RETRIES
  );
  

  // groupBlocks are augmented with information from their parent.
  const groupBlocks = await retry(
    () => pullBlocksUnderTag(groupTag, titleTag),
    config.ANKI_CONNECT_RETRIES
  );
  const groupClozeBlocks: AugmentedBlock[] =
    groupBlocks.filter(blockContainsCloze);
  const blocks: AugmentedBlock[] = singleBlocks
    .concat(groupClozeBlocks)
    .concat(basicBlocks);
  // console.log(JSON.stringify(singleBlocks, null, 2));
  // console.log(JSON.stringify(groupClozeBlocks, null, 2));
  const blockWithNid: [Block, number][] = await retry(
    () => Promise.all(blocks.map(b => processSingleBlock(b))),
    config.ANKI_CONNECT_RETRIES
  );
  
  // 查到带有 nid 的 Roam 块 : 已同步过则得到 nid，否则 NO_NID。
  const blocksWithNids = blockWithNid.filter(
    ([_, nid]) => nid !== config.NO_NID
  );
  const blocksWithNoNids = blockWithNid
    .filter(([_, nid]) => nid === config.NO_NID)
    .map(b => b[0]);

  // 现有 Anki 笔记 ： 拿到现有 notes，实现 Roam↔Anki 映射
  const existingNotes = await retry(
    () => batchFindNotes(blocksWithNids),
    config.ANKI_CONNECT_RETRIES
  );


  // STEP 2: Generate `blockWithNote` : For blocks that exist in both Anki and Roam, .
  // The schema for `blockWithNote` is shown in `NOTES.md`.

  // 数组 ：
  const blockWithNote: BlockWithNote[] = blocksWithNids.map((block, i) => {
    const _existingNote = existingNotes[i];
    const noteMetadata = JSON.parse(
      _existingNote['fields'][metadataField]['value']
    );
    _existingNote.block_time = noteMetadata['block_time'];
    _existingNote.block_uid = noteMetadata['block_uid'];
    return {nid: block[1], block: block[0], note: _existingNote};
  });

  // Toggle this on for debugging only
  // console.log("blocks with no nids" + JSON.stringify(blocksWithNoNids));
  // console.log("blockWithNote array: " + JSON.stringify(blockWithNote, null, 2));

  // STEP 3: Compute diffs between Anki and Roam
  const newerInRoam = blockWithNote.filter(
    x => x.block.time > x.note.block_time
  );
  
  const newerInAnki = blockWithNote.filter(x => {
    // First check if the block is newer in Anki based on timestamp
    if (x.block.time > x.note.block_time) {
      return false;
    }
    
    // Then check if content has changed
    if (x.block.string.includes(config.BASIC_TAG)) {
      // For basic flashcards, parse and compare front/back content
      const basicCard = parseBasicFlashcard(x.block.string);
      if (!basicCard) return false;
      
      const frontInAnki = x.note['fields'][frontField]['value'];
      const backInAnki = x.note['fields'][backField]['value'];
      
      return basicCard.front !== frontInAnki || basicCard.back !== backInAnki;
    } else {
      // For cloze flashcards, use the existing comparison
      return convertToCloze(x.block.string) !== x.note['fields'][clozeField]['value'];
    }
  });
  
  console.log('[syncNow] total synced blocks ' + blocks.length);
  console.log('[syncNow] # new blocks ' + blocksWithNoNids.length);
  console.log(
    '[syncNow] blocks being added: ' + blocksWithNoNids.map(b => b.string)
  );
  console.log(
    '[syncNow] # updated blocks/notes that are newer in roam ' +
      newerInRoam.length
  );
  console.log(
    '[syncNow] # updated blocks/notes that are newer in anki ' +
      newerInAnki.length
  );

  // STEP 4: Update Anki's outdated notes
  const updateExistingInAnki = await retry(
    () =>
      Promise.all(
        newerInRoam.map(x =>
          updateNote(
            x,
            clozeField,
            metadataField,
            groupHeaderField,
            groupTag,
            titleField,
            titleTag,
            deck,
            model,
            basicModel,
            frontField,
            backField
          )
        )
      ),
    config.ANKI_CONNECT_RETRIES
  );
  console.log(
    '[syncNow] updateExistingInAnki: ' + JSON.stringify(updateExistingInAnki)
  ); // should be an array of nulls if there are no errors

  // STEP 4.5: Delete Anki notes whose corresponding Roam blocks have been removed
  const currentBlockUids = new Set(blocks.map(b => b.uid));
  // Retrieve all notes in the target deck (could be large, but required to detect removals)
  const deckNoteIds: number[] = await retry(
    () =>
      invokeAnkiConnect(config.ANKI_CONNECT_FINDNOTES, config.ANKI_CONNECT_VERSION, {
        query: `deck:"${deck}"`,
      }),
    config.ANKI_CONNECT_RETRIES
  ) as number[];

  let deckNotesInfo: any[] = [];
  if (deckNoteIds.length > 0) {
    deckNotesInfo = (await retry(
      () =>
        invokeAnkiConnect(config.ANKI_CONNECT_NOTESINFO, config.ANKI_CONNECT_VERSION, {
          notes: deckNoteIds,
        }),
      config.ANKI_CONNECT_RETRIES
    )) as any[];
  }
  // Collect notes that were created by Fabricius (they contain metadata or UID field)
  const notesToDelete: number[] = [];
  deckNotesInfo.forEach(note => {
    let noteUid: string | null = null;
    if (
      note.fields &&
      note.fields[metadataField] &&
      note.fields[metadataField].value
    ) {
      try {
        const md = JSON.parse(note.fields[metadataField].value);
        if (md && md.block_uid) {
          noteUid = md.block_uid;
        }
      } catch (e) {
        // not JSON, ignore
      }
    }
    if (!noteUid && note.fields && note.fields[config.ANKI_FIELD_FOR_UID]) {
      noteUid = note.fields[config.ANKI_FIELD_FOR_UID].value;
    }
    if (noteUid && !currentBlockUids.has(noteUid)) {
      notesToDelete.push(Number(note.noteId));
    }
  });
  if (notesToDelete.length > 0) {
    console.log(`[syncNow] deleting notes: ${JSON.stringify(notesToDelete)}`);
    await retry(
      () => batchDeleteNotes(notesToDelete),
      config.ANKI_CONNECT_RETRIES
    );
  }

  // STEP 5: Update Roam's outdated blocks
  const updateExistingInRoam = await retry(
    () =>
      Promise.all(
        newerInAnki.map(x =>
          updateBlock(
            x,
            clozeField,
            metadataField,
            groupHeaderField,
            groupTag,
            titleField,
            titleTag,
            deck,
            model,
            basicModel,
            frontField,
            backField
          )
        )
      ),
    config.ANKI_CONNECT_RETRIES
  );
  console.log(
    '[syncNow] updateExistingInRoam: ' + JSON.stringify(updateExistingInRoam)
  ); // should be an array of nulls if there are no errors

  // STEP 6: Add new notes to Anki
  const addNewToAnki = await retry(
    () =>
      batchAddNotes(
        blocksWithNoNids,
        clozeField,
        metadataField,
        groupHeaderField,
        groupTag,
        titleField,
        titleTag,
        deck,
        model,
        basicModel,
        frontField,
        backField
      ),
    config.ANKI_CONNECT_RETRIES
  );
  console.log('[syncNow] addNewToAnki: ' + JSON.stringify(addNewToAnki));

  // STEP 7: Notify user
  render({
    id: 'syncer',
    content: `Fabricius: synced ${blocks.length} blocks (${blocksWithNoNids.length} new, ${newerInRoam.length} updated, ${notesToDelete.length} deleted)`,
    intent: Intent.SUCCESS,
  });
  console.log('[syncNow] finished');
};

// --- UI logic ---
const renderFabriciusButton = (extensionAPI: any) => {
  const syncAnkiButton = document.createElement('span');
  syncAnkiButton.id = 'sync-anki-button-span';
  syncAnkiButton.classList.add('bp3-popover-wrapper');
  syncAnkiButton.setAttribute('style', 'margin-left: 4px;');
  const outerSpan = document.createElement('span');
  outerSpan.classList.add('bp3-popover-target');
  syncAnkiButton.appendChild(outerSpan);
  const icon = document.createElement('span');
  icon.id = 'sync-anki-icon';
  icon.setAttribute('status', 'off');
  icon.classList.add(
    'bp3-icon-intersection',
    'bp3-button',
    'bp3-minimal',
    'bp3-small'
  );
  outerSpan.appendChild(icon);
  /** workaround needed because roam/js can load before the topbar */
  function renderInTopbar() {
    if (!document.getElementsByClassName('rm-topbar')) {
      window.requestAnimationFrame(renderInTopbar);
    } else {
      document
        .getElementsByClassName('rm-topbar')[0]
        .appendChild(syncAnkiButton);
    }
  }
  renderInTopbar();
  icon.onclick = () => {
    try {
      syncNow(extensionAPI);
    } catch (error) {
      render({
        id: 'syncer-error',
        content: 'Fabricius: sync failed!',
        intent: Intent.WARNING,
      });
    }
  };
};

const removeFabriciusButton = () => {
  const syncAnkiButton = document.getElementById('sync-anki-button-span');
  syncAnkiButton?.remove();
};

// --- settings panel ---
// https://github.com/panterarocks49/settings-panel-example/blob/main/extension.js
const panelConfig = {
  tabTitle: 'Fabricius',
  settings: [
    {
      id: config.GROUPED_CLOZE_TAG_KEY,
      name: 'Roam tag',
      description:
        '[Required] Children of the Roam block tagged with this is are synced as cloze text to Anki.',
      action: {
        type: 'input',
        placeholder: config.GROUPED_CLOZE_TAG,
      },
    },
    {
      id: config.TITLE_CLOZE_TAG_KEY,
      name: 'Roam tag for title',
      description:
        '[Advanced] Creates a title for any flashcards created from descendant blocks.',
      action: {
        type: 'input',
        placeholder: config.TITLE_CLOZE_TAG,
      },
    },
    {
      id: config.ANKI_DECK_NAME_KEY,
      name: 'Anki deck',
      description: '[Required] The Anki deck to be synced to.',
      action: {
        type: 'input',
        placeholder: config.ANKI_DECK_NAME,
      },
    },
    {
      id: config.ANKI_MODEL_NAME_KEY,
      name: 'Anki model',
      description:
        '[Required] The Anki model (note type) that will be created in syncs. This must contain all required fields (prefixed by [Anki note field]).',
      action: {
        type: 'input',
        placeholder: config.ANKI_MODEL_NAME,
      },
    },
    {
      id: config.ANKI_BASIC_MODEL_NAME_KEY,
      name: 'Anki basic model',
      description:
        '[Required] The Anki model (note type) that will be created in syncs for basic flashcards. This must contain all required fields (prefixed by [Anki note field]).',
      action: {
        type: 'input',
        placeholder: config.ANKI_BASIC_MODEL_NAME,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_CLOZE_TEXT_KEY,
      name: '[Anki note field] cloze text',
      description: '[Required]',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_CLOZE_TEXT,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_TITLE_KEY,
      name: '[Anki note field] title',
      description: '[Required]',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_TITLE,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_GROUP_HEADER_KEY,
      name: '[Anki note field] group header',
      description: '[Required]',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_GROUP_HEADER,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_METADATA_KEY,
      name: '[Anki note field] metadata',
      description:
        '[Required] Used by the extension to store sync metadata for the Anki note, in the note itself.',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_METADATA,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_FRONT_KEY,
      name: '[Anki note field] front',
      description: '[Required]',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_FRONT,
      },
    },
    {
      id: config.ANKI_FIELD_FOR_BACK_KEY,
      name: '[Anki note field] back',
      description: '[Required]',
      action: {
        type: 'input',
        placeholder: config.ANKI_FIELD_FOR_BACK,
      },
    }
  ],
};

// --- for Roam Depot loading ---

const onload = ({extensionAPI}: {extensionAPI: any}) => {
  extensionAPI.settings.panel.create(panelConfig);
  console.log('[Fabricius] loading');
  renderFabriciusButton(extensionAPI);
  console.log('[Fabricius] loaded');
};

export default {
  onload: onload,
  onunload: () => {
    removeFabriciusButton();
  },
};

// --- Helpers ---

// Retries an async call
const retry = async (fn: () => Promise<any>, n: number) => {
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`Retry attempt ${i + 1} failed:`, error);
    }
  }
  render({
    id: 'syncer',
    content:
      'Fabricius: failed to sync. Is Anki open? Are you on Mac? https://foosoft.net/projects/anki-connect/#:~:text=Notes%20for%20MacOS%20Users',
    intent: Intent.DANGER,
  });
  throw new Error(`Failed retrying ${n} times`);
};

// 从一个 Promise 中获取字符串结果，如果结果是空或 null，就返回一个默认值。
const getOrDefault = async (r: Promise<string>, d: string): Promise<string> => {
  const res = await r;
  if (res === null || res.trim() === '') {
    return d;
  }
  return res;
};

// updateBlock mutates `blockWithNote`.
const updateBlock = async (
  blockWithNote: BlockWithNote,
  clozeTextField: string,
  clozeTagField: string,
  groupHeaderField: string,
  groupedClozeTag: string,
  titleField: string,
  titleClozeTag: string,
  deck: string,
  model: string,
  basicModel: string,
  frontField: string,
  backField: string
): Promise<any> => {
  let blockText;
  // Check if this is a basic flashcard
  if (blockWithNote.block.string.includes(config.BASIC_TAG)) {
    // For basic flashcards, construct the format (Front) ... (Back) ...
    const front = blockWithNote.note.fields[frontField]['value'];
    const back = blockWithNote.note.fields[backField]['value'];
    const frontText = basicHtmlToMarkdown(front);
    const backText = basicHtmlToMarkdown(back);
    // Add the tag at the end, not within the content
    blockText = `(Front) ${frontText} (Back) ${backText} #${config.BASIC_TAG}`;
  } else {
    // For cloze flashcards, use the existing logic
    const noteText = blockWithNote.note.fields[clozeTextField]['value'];
    blockText = convertToRoamBlock(noteText);
  }
  // success? - boolean
  const updateRes = window.roamAlphaAPI.updateBlock({
    block: {
      uid: blockWithNote.block.uid,
      string: blockText,
    },
  });
  if (!updateRes) {
    console.log('[updateBlock] failed to update');
    return;
  }
  // The block will have a newer modified time than the Anki note. But we don't know what value it is. We query for it after waiting, and update the note in Anki.
  await new Promise(r => setTimeout(r, 200));
  const updateTime = window.roamAlphaAPI.q(
    `[ :find (pull ?e [ :edit/time ]) :where [?e :block/uid "${blockWithNote.block.uid}"]]`
  )[0][0].time;
  // console.log(updateTime);
  blockWithNote.block.time = updateTime;
  blockWithNote.block.string = blockText;
  return updateNote(
    blockWithNote,
    clozeTextField,
    clozeTagField,
    groupHeaderField,
    groupedClozeTag,
    titleField,
    titleClozeTag,
    deck,
    model,
    basicModel,
    frontField,
    backField
  );
};

const processSingleBlock = async (block: Block): Promise<[Block, Number]> => {
  // console.log('searching for block ' + block.uid);
  // Determine which model to search for based on the block content
  const modelName = block.string.includes(config.BASIC_TAG) 
    ? config.ANKI_BASIC_MODEL_NAME 
    : config.ANKI_MODEL_NAME;
  
  // TODO: should do a more exact structural match on the block uid here, but a collision *seems* unlikely.
  const nid: Number | null | Number[] = await invokeAnkiConnect(
    config.ANKI_CONNECT_FINDNOTES,
    config.ANKI_CONNECT_VERSION,
    {
      query: `${config.ANKI_FIELD_FOR_METADATA}:re:${block.uid} AND note:${modelName}`,
    }
  );
  if (nid === null) {
    throw new Error('[processSingleBlock] null note ID');
  }
  if (Array.isArray(nid)) {
    if (nid.length === 0) {
      // create card in Anki
      return [block, config.NO_NID];
    } else {
      // TODO(can be improved)
      // assume that only 1 note matches
      return [block, nid[0]];
    }
  }
  throw new Error('[processSingleBlock] malformed note ID');
};

const blockContainsCloze = (block: AugmentedBlock) => {
  const found = block.string.match(/{c(\d+):([^}]*)}/g);
  return found !== null && found.length !== 0;
};

const ANKI_CLOZE_PATTERN = /{{c(\d+)::([^}:]*)}}/g;
const ANKI_CLOZE_WITH_HINT_PATTERN = /{{c(\d+)::([^}:]*)::([^}]*)}}/g;

// String manipulation functions
const convertToRoamBlock = (s: string) => {
  if (s.match(ANKI_CLOZE_PATTERN)) {
    s = s.replace(ANKI_CLOZE_PATTERN, '{c$1:$2}');
  } else if (s.match(ANKI_CLOZE_WITH_HINT_PATTERN)) {
    s = s.replace(ANKI_CLOZE_WITH_HINT_PATTERN, '{c$1:$2:hint:$3}');
  }
  s = basicHtmlToMarkdown(s);
  return s;
};

const basicHtmlToMarkdown = (s: string) => {
  // Convert HTML back to markdown
  s = s.replace(/<b>(.*?)<\/b>/g, '**$1**');
  s = s.replace(/<i>(.*?)<\/i>/g, '__$1__');
  s = s.replace('&nbsp;', ' ');
  s = s.replace(/<br>/g, '\n');
  // Convert HTML img tags back to markdown
  s = s.replace(/<img src="(https?:\/\/[^"]+)">/g, '![]($1)');
  return s;
};
