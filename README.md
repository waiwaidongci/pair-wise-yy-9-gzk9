# 古法蓝晒底片整理室

运行：

```bash
npm start
```

访问`http://localhost:3040`。数据保存在`data/cyanotype-negative-room.json`。

## 数字化交付（扫描单）

访问`http://localhost:3040/scan`。扫描单数据保存在`data/scan-orders.json`。

- `scan-rules.js`：业务规则（待复扫判定、底片/工位唯一性、交付退回与失效）
- `scan-store.js`：记录保存（JSON 文件读写）
- `scan-page.js`：页面与页面操作（登记、交付、更正、历次扫描视图）
