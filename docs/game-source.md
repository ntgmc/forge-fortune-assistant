# 游戏脚本与数据定位

本文记录如何从《锻造与财富》中文版网页定位游戏脚本，读取压缩后的实现，并找到助手使用的配置。分析游戏机制时先确认当前部署的文件，再与助手的近似模拟对照。

## 信息地址

| 内容 | 地址 | 用途 |
| --- | --- | --- |
| 游戏首页 | https://game.itwmw.com/forge-fortune/ | 查找当前 `<script type="module" src="./assets/index-*.js">` |
| 游戏 JS（2026-09-24 观察到的版本） | https://game.itwmw.com/forge-fortune/assets/index-CIdAnlew.js | 对照游戏实际实现；`index-*.js` 的哈希会随部署变化 |
| 装备效果样式（2026-09-24 观察到的版本） | https://game.itwmw.com/forge-fortune/css/equipment-effects.css?v=11 | 辅助定位装备效果的展示区域；战斗逻辑以 JS 为准 |
| 配方 | https://game.itwmw.com/forge-fortune/json/recipes.json | 装备类型、属性与点数 |
| 材料 | https://game.itwmw.com/forge-fortune/json/materials.json | 制作资源 |
| 英雄 | https://game.itwmw.com/forge-fortune/json/heroes.json | 基础属性与可用技能书 |
| 地下城 | https://game.itwmw.com/forge-fortune/json/dungeons.json | 难度、队伍人数、怪物与层数成长 |
| 怪物 | https://game.itwmw.com/forge-fortune/json/mobs.json | 怪物属性倍率与技能 ID |
| 技能书 | https://game.itwmw.com/forge-fortune/json/playbook.json | 每本书的技能序列 |
| 技能 | https://game.itwmw.com/forge-fortune/json/skills.json | 技能说明与倍率 |
| 其他配置 | https://game.itwmw.com/forge-fortune/json/misc.json | 品质倍率等；助手读取数组的首项 |

脚本中的 [`loadConfig()`](../forge-fortune-assistant.user.js) 按上述八个 JSON 文件读取配置。网页当前存档另存在浏览器的 `localStorage.ffgs1` 中，不是这些公开配置，也不是仓库中的测试存档。

## 获取当前部署的 JS

在 Linux shell 中运行以下命令，从首页提取实际引用的文件名，再下载到临时位置：

```sh
base='https://game.itwmw.com/forge-fortune'
entry=$(curl -fsSL "$base/" | sed -n 's/.*src="\.\/\(assets\/index-[^"]*\.js\)".*/\1/p' | head -n 1)
test -n "$entry" && curl -fsSL "$base/$entry" -o /tmp/forge-fortune-game.js &&
  printf '%s\n' "$base/$entry"
```

如果 `entry` 为空，先检查首页 HTML 中的模块脚本标签；不要沿用上表中的旧哈希。分析结束后可运行 `rm /tmp/forge-fortune-game.js` 清理临时副本。

## 从压缩 JS 定位实现

部署文件通常把多个模块压在很少的行里。`rg -n` 可能输出整条超长代码行；用 `rg -o` 限制上下文，按**中文界面文案、稳定的字段名或效果 ID**定位：

```sh
rg -o '.{0,120}(血契复苏|不灭守护|破阵追击|equipmentDungeon|expeditionBonuses).{0,220}' /tmp/forge-fortune-game.js
```

需要更多上下文时，按字符位置截取。这里的 Node.js 仅用于读取和定位已经下载的压缩文件：

```sh
node -e '
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[1], "utf8");
for (const key of process.argv.slice(2)) {
  const at = text.indexOf(key);
  console.log(`\n${key}: ${at}`);
  if (at >= 0) console.log(text.slice(Math.max(0, at - 400), at + 1600));
}
' /tmp/forge-fortune-game.js '血契复苏' 'equipmentDungeon' 'expeditionBonuses'
```

也可在浏览器开发者工具的 Sources 中打开当前 `index-*.js`，使用 `{}` 格式化显示后搜索相同关键词。阅读时从命中位置向前找到所属对象或立即执行函数的起点，向后核对触发条件、叠加上限、结算顺序与调用方。压缩后的单字母变量和函数名会改变，不要把它们当成稳定 API；搜索不到时先检查最新入口及界面文案是否改变。

装备效果可从系列名（`blood`、`assault`、`guardian` 等）及“装备特效总览 · 地下城效果”附近定位：定义包含装备类型、品质、普通词条和太初独效；战斗实现还需追到 `equipmentDungeon` 的伤害、治疗、回合和楼层处理。`expeditionBonuses`、`expeditionStats` 及“远征效果总览”对应**普通远征和英雄任务**的攻血加成，不能加入地下城冒险的英雄属性。对照助手的 [`dungeonEquipmentEffects()`](../forge-fortune-assistant.user.js) 和 [`simulateFloor()`](../forge-fortune-assistant.user.js) 时，只采用地下城实际生效且模拟已实现的机制。

配置 JSON 用 `id` 将配方、英雄、地下城、怪物、技能书和技能串起来；读取字段前可先用 `curl -fsSL "$base/json/skills.json"` 检查当前结构。更改模拟规则后运行 `node --test test/assistant.test.js`，并注意压缩脚本可能已有新版本。
