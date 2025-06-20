# Development

- reload roam after replacing javascript, otherwise plugin will not update.
- `npm run bundle` to compile typescript.

# Notes

- Q: Should we resolve block refs? How about recursively?
- A: Maybe we should just support hyperlinks/aliases instead.

This is what the array of {nid, block, note} looks like:

```
    nid: number,          // Anki – 该笔记在 Anki 中的 noteId

    block: {              // Roam – Roam 返回的块对象
      string: string,     // 块内容
      uid: string,        // Roam 块唯一 ID
      time: number,       // 最后编辑时间（Unix 毫秒）
      ...                 // refs / children / parents / page / order 等 Roam 元数据
    },

    note: {               // Anki – 与上面 block 对应的笔记
      noteId: number,     // = nid
      modelName: string,  // 笔记类型（如 "ClozeRoam" 或自定义 basic 类型）
      tags: string[],
      fields: {           // Anki 中各字段的值
        Text / Front / Back / … : { value, order },
        TextUID:  {       // 存放 Roam 元数据的字段
          value: "{\"block_uid\":\"...\",\"block_time\":...}",
          order: ...
        }
      },
      cards: number[],    // 该笔记下的卡片 ID

      // 下面两个属性是在代码里解析 TextUID 字段后"挂"上去的，方便比较时间与 UID
      block_time: number, // 来自 TextUID → block_time  → Roam
      block_uid: string   // 来自 TextUID → block_uid   → Roam
    }
  }
```

```json


[
  {
    "nid": 1622824657081,
    "block": {
      "string": "DECK1: A nice {c1: block} #[[srs/cloze]] #[[test]]",
      "refs": [
        {
          "id": 45
        },
        {
          "id": 63
        }
      ],
      "user": {
        "id": 1
      },
      "children": [
        {
          "id": 64
        },
        {
          "id": 65
        }
      ],
      "uid": "pLrlQUqrE",
      "open": true,
      "time": 1603364362454,
      "id": 13,
      "parents": [
        {
          "id": 9
        }
      ],
      "order": 1,
      "page": {
        "id": 9
      }
    },
    "note": {
      "noteId": 1622824657081,
      "tags": [],
      "fields": {
        "Text": {
          "value": "DECK1: A nice {{c1:: block}} #[[srs/cloze]] #[[test]]",
          "order": 0
        },
        "TextUID": {
          "value": "{\"block_uid\":\"pLrlQUqrE\",\"block_time\":1603364362454}",
          "order": 1
        },
        "Back Extra": {
          "value": "",
          "order": 2
        }
      },
      "modelName": "ClozeRoam",
      "cards": [1622824657081],
      "block_time": 1603364362454,
      "block_uid": "pLrlQUqrE"
    }
  }
]
```
