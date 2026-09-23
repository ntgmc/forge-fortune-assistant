const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { analyze, itemStats, boostAdvice, bestBooks, equipmentAdvice, partyScore,
  freeMastery, fusionCandidates, fusionBorrowCandidates, fusionUpgradeStep,
  fusionHasSlot, nextPartyMove,
  schedulePlaybookDialogClose, simulateDungeon, simulateFloor, adventureWorkerSource,
  adventureFingerprint, analyzeLiveSave } =
  require("../forge-fortune-assistant.user.js");

const basicRecipe = (id, pts = 10) => ({
  id, name: id, type: "Swords", pow: 3, hp: 0, pts, craftTime: 1000,
  canForge: true, mcost: { M1: 2 }
});
const basicHero = (id, pow = 30, hp = 200, type = "Might") => ({
  id, name: id, info: { id, type, playbooks: ["PB1", "PB2"],
    slot1Type: "Swords" }, playbook: "PB1", pow, hp, currentHp: hp,
  gear: [{ id: "R1", rarity: 1, sharp: 0 }]
});
const fixture = {
  recipes: [basicRecipe("R1"), basicRecipe("R2", 20), basicRecipe("R3", 24)],
  materials: [{ id: "M1", name: "木材" }],
  heroes: [],
  dungeons: [1, 2, 3].map((area) => ({
    id: `D${area}01`, name: `区域${area}`, type: "dungeon", partySize: 4,
    pow: 50 + area * 10, hp: 300, powGain: 0, hpGain: 0,
    mob1: "B1", mob2: "B2", mob3: "B3", mob4: "B4"
  })),
  mobs: ["B1", "B2", "B3", "B4"].map((id) => ({
    id, hpMod: 0.1, powMod: 0.1,
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000"
  })),
  playbook: [
    { id: "PB1", name: "单体", skill1: "S1",
      skill2: "S0000", skill3: "S0000", skill4: "S0000" },
    { id: "PB2", name: "群攻", skill1: "S2",
      skill2: "S0000", skill3: "S0000", skill4: "S0000" }
  ],
  skills: [
    { id: "S0000", powMod: 1 },
    { id: "S1", powMod: 3, description: "对前方敌人造成伤害" },
    { id: "S2", powMod: 2, description: "对所有敌人造成伤害" }
  ],
  misc: { rarityMod: [1, 2, 3, 4, 5, 7, 12],
    fuelBoosts: [
      { perkId: "AL1", multiplier: 3, costPerSecond: 1 },
      { perkId: "AL2", multiplier: 5, costPerSecond: 2 }
    ] }
};
const save = {
  ver: 2,
  h: { heroes: Array.from({ length: 12 }, (_, i) => ({
    id: `H${i}`, hp: 200, owned: true, playbook: "PB1",
    gearSlots: [{ gear: { id: "R1", rarity: 1, sharp: 0 } }]
  })) },
  d: { dungeons: [1, 2, 3].map((area) => ({
    id: `D${area}01`, status: 1, maxFloor: 1, floor: 2,
    party: { heroID: Array.from({ length: 4 }, (_, i) => `H${(area - 1) * 4 + i}`) }
  })) },
  i: [], r: fixture.recipes.map(({ id }) => ({ id, owned: true })),
  rs: [{ id: "M1", amt: 8 }],
  sh: { perks: [{ id: "AL1", purchased: true }, { id: "AL2", purchased: true }] },
  ds: { fuel: 3600, boostLevel: 1 },
  pb: { playbookDB: [{ id: "PB1", unlocked: true }, { id: "PB2", unlocked: true }] },
  as: { slots: [{ status: 1, craftTime: 800 }] }
};
fixture.heroes = Array.from({ length: 12 }, (_, i) => ({
  id: `H${i}`, name: `英雄${i}`, type: "Might", initialPow: 10,
  initialHP: 200, playbooks: ["PB1", "PB2"], slot1Type: "Swords"
}));

test("equipment stats use rarity, sharpness and transformed attributes", () => {
  assert.deepEqual(itemStats({ rarity: 1, sharp: 2, powRatio: 0, hpRatio: 3 },
    fixture.recipes[0], fixture.misc.rarityMod), { pow: 0, hp: 594 });
});

test("boost plan chooses the fastest unlocked tier sustainable for its stated horizon", () => {
  assert.match(boostAdvice(save, fixture).recommendation, /现在开 5 倍.*3,600 精华/);
  assert.match(boostAdvice({ ...save, ds: { fuel: 0.1 } }, fixture).recommendation,
    /精华不足以维持.*0.1 秒/);
});

test("joint assignment fills all three areas without duplicating heroes", () => {
  const result = analyze(save, fixture);
  assert.equal(result.adventure.areas.length, 3);
  const members = result.adventure.areas.flatMap((area) => area.members);
  assert.equal(new Set(members.map((hero) => hero.id)).size, 12);
  assert.equal(result.skills.length, 12);
  assert.ok(result.adventure.areas.every((area) =>
    area.profiles.every((profile) => profile.book)));
});

test("adventure targets highest unlocked tier even when a lower tier is running", () => {
  const data = { ...fixture, dungeons: [
    ...fixture.dungeons,
    { ...fixture.dungeons[0], id: "D102", pow: 350, hp: 1500, unlockedBy: "D401" },
    { ...fixture.dungeons[0], id: "D103", pow: 500, hp: 2000, unlockedBy: "D402" }
  ] };
  const progress = { ...save, d: { dungeons: [
    ...save.d.dungeons,
    { id: "D102", status: 0, maxFloor: 0, floor: 1 },
    { id: "D103", status: 0, maxFloor: 0, floor: 1 },
    { id: "D401", status: 0, maxFloor: 1 },
    { id: "D402", status: 0, maxFloor: 0 }
  ] } };
  const area = analyze(progress, data).adventure.areas[0];
  assert.equal(area.id, "D102");
  assert.equal(area.running.id, "D101");
  assert.equal(area.encounter.pow, 350);
  assert.equal(area.encounter.frontHp, 150);
});

test("adventure falls back when an unlocked harder dungeon cannot clear floor one", () => {
  const base = fixture.dungeons[1];
  const data = { ...fixture, dungeons: [
    ...fixture.dungeons,
    { ...base, id: "D202", unlockedBy: "D401", hp: 100000, pow: 100000 }
  ] };
  const progress = { ...save, d: { dungeons: [
    ...save.d.dungeons,
    { id: "D202", status: 0, maxFloor: 0, floor: 1 },
    { id: "D401", status: 0, maxFloor: 1 }
  ] } };
  const plan = analyze(progress, data).adventure;
  assert.equal(plan.areas.length, 3);
  assert.equal(plan.areas[1].id, "D201");
  assert.ok(plan.areas.every((area) => area.simulation.floors >= 1));
});

test("one blocked region falls back without downgrading the other regions", () => {
  const data = { ...fixture, dungeons: [
    ...fixture.dungeons,
    ...fixture.dungeons.map((dungeon, index) => ({
      ...dungeon, id: `D${index + 1}02`, unlockedBy: "D401",
      hp: index === 1 ? 100000 : 100, pow: index === 1 ? 100000 : 30
    }))
  ] };
  const progress = { ...save, d: { dungeons: [
    ...save.d.dungeons,
    ...[1, 2, 3].map((area) => ({ id: `D${area}02`, status: 0, maxFloor: 0 })),
    { id: "D401", status: 0, maxFloor: 1 }
  ] } };
  assert.deepEqual(analyze(progress, data).adventure.areas.map((area) => area.id),
    ["D102", "D201", "D302"]);
});

test("observed second floor keeps left and right IX while blocked middle IX falls back", () => {
  const data = { ...fixture, dungeons: [
    ...fixture.dungeons,
    ...fixture.dungeons.map((dungeon, index) => ({
      ...dungeon, id: `D${index + 1}09`, unlockedBy: "D401",
      hp: 100000, pow: 100000
    }))
  ] };
  const states = save.d.dungeons.map((state) => ({ ...state, status: 0, floor: 1 }));
  const running = (index) => ({
    id: `D${index + 1}09`, status: 1, maxFloor: 0, floor: 2,
    party: { heroID: save.d.dungeons[index].party.heroID },
    lastPlaybook: Array(4).fill("PB1")
  });
  const progress = { ...save, d: { dungeons: [
    ...states, running(0), { ...running(1), status: 0, floor: 1 },
    running(2), { id: "D401", maxFloor: 1, status: 0 }
  ] } };
  const plan = analyze(progress, data).adventure;
  assert.deepEqual(plan.areas.map((area) => area.id), ["D109", "D201", "D309"]);
  assert.deepEqual(plan.areas.map((area) => !!area.observed), [true, false, true]);
  assert.ok(plan.areas.every((area) => area.simulation.floors >= 1));
  let response;
  const context = { self: { postMessage: (message) => { response = message; } } };
  vm.runInNewContext(adventureWorkerSource(), context);
  context.self.onmessage({ data: { save: progress, config: data } });
  assert.equal(response.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.areas.map((area) =>
    [area.id, !!area.observed]))), plan.areas.map((area) => [area.id, !!area.observed]));
  assert.equal(adventureFingerprint(progress), adventureFingerprint({
    ...progress, d: { dungeons: progress.d.dungeons.map((state) =>
      state.status === 1 && state.floor > 1 ? { ...state, floor: 15 } : state) }
  }));
});

test("observed victory requires matching running dungeon, roster and playbooks", () => {
  const harder = { ...fixture.dungeons[0], id: "D109", unlockedBy: "D401",
    hp: 100000, pow: 100000 };
  const data = { ...fixture, dungeons: [...fixture.dungeons, harder] };
  const run = {
    id: "D109", status: 1, maxFloor: 0, floor: 2,
    party: { heroID: save.d.dungeons[0].party.heroID },
    lastPlaybook: Array(4).fill("PB1")
  };
  const progress = { ...save, d: { dungeons: [
    { ...save.d.dungeons[0], status: 0 },
    ...save.d.dungeons.slice(1), run, { id: "D401", maxFloor: 1, status: 0 }
  ] } };
  const first = (state) => analyze(state, data).adventure.areas[0];
  assert.equal(first(progress).id, "D109");
  const replace = (change) => ({ ...progress, d: { dungeons:
    progress.d.dungeons.map((state) => state.id === "D109" ? { ...state, ...change } : state) } });
  assert.equal(first(replace({ floor: 1 })).id, "D101");
  assert.equal(first(replace({ party: { heroID: ["H0", "H0", "H2", "H3"] } })).id, "D101");
  assert.equal(first(replace({ lastPlaybook: ["PB2", "PB1", "PB1", "PB1"] })).id, "D101");
  assert.equal(first(replace({ id: "D108" })).id, "D101");
});

test("live analysis restarts on team changes and reads newest non-team values", async () => {
  let live = save;
  const calls = [];
  const project = async (state) => {
    calls.push(state);
    if (calls.length === 1) live = { ...live, h: { heroes: live.h.heroes.map((hero, i) =>
      i === 0 ? { ...hero, playbook: "PB2" } : hero) } };
    else live = { ...live, ds: { ...live.ds, fuel: 42 } };
    return { areas: [], reason: "测试中的冒险模拟" };
  };
  const result = await analyzeLiveSave(() => live, fixture, project);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].h.heroes[0].playbook, "PB2");
  assert.equal(result.report.boost.fuel, 42);
  assert.equal(result.save, live);
});

test("no simulated first-floor victory means no actionable party", () => {
  const data = { ...fixture, dungeons: fixture.dungeons.map((dungeon) =>
    ({ ...dungeon, pow: 1e6, hp: 1e6 })) };
  const plan = analyze(save, data).adventure;
  assert.equal(plan.areas.length, 0);
  assert.match(plan.reason, /首层/);
});

test("ghost-area phase and evasion cost additional simulated turns", () => {
  const def = { mob1: "B205", mob2: null, mob3: null, mob4: null,
    hp: 240, pow: 60, hpGain: 0, powGain: 0 };
  const profile = { hero: { hp: 200, pow: 60 }, book: {
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000"
  } };
  const skills = new Map([
    ["S0000", { id: "S0000", powMod: 1 }],
    ["SM205", { id: "SM205", powMod: 1 }],
    ["SM208", { id: "SM208", powMod: 1 }]
  ]);
  const ordinary = [{ id: "B205", hpMod: 1, powMod: 1,
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000" }];
  const phased = [{ ...ordinary[0], skill1: "SM205" }];
  const direct = simulateFloor([profile], def, ordinary, skills, 1);
  assert.equal(direct.cleared, true);
  assert.ok(simulateFloor([profile], def, phased, skills, 1).turns > direct.turns);
  const evasive = [{ ...ordinary[0], skill2: "SM208" }];
  assert.ok(simulateFloor([profile], def, evasive, skills, 1).turns > direct.turns);
});

test("unknown enemy skills cannot be counted as harmless", () => {
  const profile = { hero: { hp: 200, pow: 40 }, book: {
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000"
  } };
  const mob = { hpMod: 1, powMod: 1,
    skill1: "SM_UNKNOWN", skill2: "S0000", skill3: "S0000", skill4: "S0000" };
  assert.equal(simulateFloor([profile], { hp: 100, pow: 1 }, [mob],
    new Map([["S0000", { powMod: 1 }]]), 1), null);
});

test("first-floor safety rejects a fragile team despite a baseline victory", () => {
  const profile = { hero: { hp: 80, pow: 100 }, book: {
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000"
  } };
  const mob = { hpMod: 1, powMod: 1,
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000" };
  const def = { hp: 100, pow: 80 };
  const skills = new Map([["S0000", { powMod: 1 }]]);
  assert.equal(simulateFloor([profile], def, [mob], skills, 1).cleared, true);
  assert.equal(simulateFloor([profile], def, [mob], skills, 1, 1.2).cleared, false);
});

test("ghost-area falling rocks halve party HP rather than do nothing", () => {
  const profile = { hero: { hp: 200, pow: 0 }, book: {
    skill1: "S0000", skill2: "S0000", skill3: "S0000", skill4: "S0000"
  } };
  const mob = { hpMod: 1, powMod: 1,
    skill1: "SM207", skill2: "SM207", skill3: "SM207", skill4: "SM207" };
  const skills = new Map([
    ["S0000", { powMod: 1 }], ["SM207", { powMod: 1 }]
  ]);
  assert.equal(simulateFloor([profile], { hp: 100, pow: 100 }, [mob],
    skills, 1).remaining, 100);
});

test("worker combat search matches main-thread result", () => {
  let response;
  const context = { self: { postMessage: (message) => { response = message; } } };
  vm.runInNewContext(adventureWorkerSource(), context);
  context.self.onmessage({ data: { save, config: fixture } });
  assert.equal(response.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result.areas.map((area) =>
    [area.id, area.simulation.floors, area.members.map((hero) => hero.id)]))),
  analyze(save, fixture).adventure.areas.map((area) =>
    [area.id, area.simulation.floors, area.members.map((hero) => hero.id)]));
});

test("purchased unlock makes an unvisited dungeon eligible", () => {
  const data = { ...fixture, dungeons: [
    ...fixture.dungeons,
    { ...fixture.dungeons[1], id: "D202", unlockedBy: "AL2" }
  ] };
  const progress = { ...save, d: { dungeons: [
    ...save.d.dungeons,
    { id: "D202", status: 0, maxFloor: 0, floor: 1 }
  ] } };
  assert.equal(analyze(progress, data).adventure.areas[1].id, "D202");
});

test("floor and live mobs never change adventure teams or skills", () => {
  const first = analyze(save, fixture);
  const changed = { ...save, d: { dungeons: save.d.dungeons.map((dungeon) =>
    ({ ...dungeon, floor: 90, mobs: [{ hpmax: 999999, hp: 1, pow: 90000 }] })) } };
  const second = analyze(changed, fixture);
  const plan = (report) => report.adventure.areas.map((area) => ({
    id: area.id,
    encounter: area.encounter,
    members: area.members.map((hero) => hero.id),
    books: area.profiles.map((profile) => profile.book.id)
  }));
  assert.deepEqual(plan(first), plan(second));
  assert.strictEqual(first.adventure, second.adventure);
});

test("free mastery requires ownership, craft threshold, and zero cost", () => {
  const data = { ...fixture, recipes: [
    { ...fixture.recipes[0], recipeType: "normal", minCraft: 10, masteryTotal: 60, masteryAmt: 2 },
    { ...fixture.recipes[1], recipeType: "normal", minCraft: 10, masteryTotal: 60, masteryAmt: 2 },
    { ...fixture.recipes[2], recipeType: "normal", minCraft: 10, masteryTotal: 60, masteryAmt: 2 }
  ] };
  const progress = { ...save, r: [
    { id: "R1", owned: true, craftCount: 40, mastered: false },
    { id: "R2", owned: true, craftCount: 39, mastered: false },
    { id: "R3", owned: true, craftCount: 50, mastered: true }
  ] };
  assert.deepEqual(freeMastery(progress, data), ["R1"]);
});

test("fusion reserves one item and requires sufficient gold", () => {
  const data = { ...fixture, recipes: [
    { ...fixture.recipes[0], recipeType: "normal", value: 10 },
    { ...fixture.recipes[1], recipeType: "normal", value: 10 }
  ] };
  const progress = { ...save, i: [
    { id: "R1", qty: 4, rarity: 1, sharp: 0, rune: 0, powRatio: 3, hpRatio: 0 },
    { id: "R2", qty: 3, rarity: 1, sharp: 0, rune: 0, powRatio: 3, hpRatio: 0 }
  ], rs: [{ id: "M001", amt: 80 }] };
  assert.deepEqual(fusionCandidates(progress, data), [
    { id: "R1", qty: 4, rarity: 1, uniqueID: "R1_1_0_0_0" }
  ]);
  assert.deepEqual(fusionCandidates({ ...progress, rs: [{ id: "M001", amt: 79 }] }, data), []);
});

test("fusion waits for an unlocked empty slot", () => {
  const slots = [{ uniqueID: "first" }, { uniqueID: "second" }];
  assert.equal(fusionHasSlot({ ...save, fb: { slots } }), false);
  assert.equal(fusionHasSlot({ ...save, fb: { slots },
    sh: { perks: [{ id: "AL3006", purchased: true }] } }), true);
  assert.equal(fusionHasSlot({ ...save, fb: { slots: [...slots, {}] },
    sh: { perks: [{ id: "AL3006", purchased: true }] } }), false);
});
test("fusion borrows exactly one matching equipped item from an idle hero", () => {
  const data = { ...fixture, recipes: fixture.recipes.map((recipe) =>
    ({ ...recipe, recipeType: "normal", value: 10 })) };
  const gear = { id: "R1", rarity: 1, sharp: 0, rune: 0, powRatio: 3, hpRatio: 0 };
  const progress = { ...save,
    h: { heroes: save.h.heroes.map((hero, index) => index === 0 ?
      { ...hero, gearSlots: [{ gear }] } : hero) },
    d: { dungeons: save.d.dungeons.map((dungeon) => ({ ...dungeon, status: 0 })) },
    i: [{ ...gear, qty: 2 }], rs: [{ id: "M001", amt: 80 }], fb: { slots: [] }
  };
  const candidate = fusionBorrowCandidates(progress, data);
  assert.deepEqual(candidate, [{
    heroId: "H0", slotIndex: 0, gearType: "Swords", id: "R1", rarity: 1,
    uniqueID: "R1_1_0_0_0", outputID: "R1_2_0_0_0", outputQty: 0
  }]);
  assert.equal(fusionUpgradeStep(progress, data, { ...candidate[0], stage: "unequip" }), "unequip");
  assert.deepEqual(fusionBorrowCandidates({
    ...progress, d: save.d
  }, data), []);
  assert.deepEqual(fusionBorrowCandidates({
    ...progress, h: { heroes: progress.h.heroes.map((hero, index) =>
      index === 0 ? { ...hero, gearSlots: [{ gear: { ...gear, sharp: 1 } }] } : hero) }
  }, data), []);
  assert.deepEqual(fusionBorrowCandidates({
    ...progress, rs: [{ id: "M001", amt: 79 }]
  }, data), []);
  assert.deepEqual(fusionBorrowCandidates({
    ...progress, fb: { slots: [{}, {}] }
  }, data), []);
  assert.deepEqual(fusionBorrowCandidates({
    ...progress, i: [{ ...gear, qty: 3 }]
  }, data), []);
});

test("borrowed fusion waits for save confirmation then equips the new item", () => {
  const data = { ...fixture, recipes: fixture.recipes.map((recipe) =>
    ({ ...recipe, recipeType: "normal", value: 10 })) };
  const gear = { id: "R1", rarity: 1, sharp: 0, rune: 0, powRatio: 3, hpRatio: 0 };
  const withGear = (item) => ({ ...save, h: { heroes: save.h.heroes.map((hero, index) =>
    index === 0 ? { ...hero, gearSlots: [{ gear: item }] } : hero) },
  d: { dungeons: save.d.dungeons.map((dungeon) => ({ ...dungeon, status: 0 })) },
  rs: [{ id: "M001", amt: 80 }], fb: { slots: [] } });
  const equipped = { ...withGear(gear), i: [{ ...gear, qty: 2 }] };
  const plan = { ...fusionBorrowCandidates(equipped, data)[0], startedAt: Date.now() };
  assert.equal(fusionUpgradeStep(equipped, data, { ...plan, stage: "start" }), "wait");
  const removed = { ...withGear(null), i: [{ ...gear, qty: 3 }] };
  assert.equal(fusionUpgradeStep(removed, data, { ...plan, stage: "start" }), "start");
  const fusing = { ...removed, i: [], fb: { slots: [{ uniqueID: plan.outputID }] } };
  assert.equal(fusionUpgradeStep(fusing, data, { ...plan, stage: "fusing" }), "wait");
  assert.equal(fusionUpgradeStep({ ...removed, i: [{ ...gear, rarity: 2, qty: 1 }] },
    data, { ...plan, outputQty: 1, stage: "fusing" }), "wait");
  const output = { ...withGear(null), i: [{ ...gear, rarity: 2, qty: 1 }] };
  assert.equal(fusionUpgradeStep(output, data, { ...plan, stage: "fusing" }), "equip");
  assert.equal(fusionUpgradeStep(output, data, { ...plan, stage: "equip" }), "equip");
  assert.equal(fusionUpgradeStep({ ...output, i: [{ ...gear, rarity: 2, qty: 2 }] },
    data, { ...plan, outputQty: 1, stage: "fusing" }), "equip");
  assert.equal(fusionUpgradeStep({ ...withGear({ ...gear, rarity: 2 }), i: [] },
    data, { ...plan, stage: "equip" }), "complete");
  assert.equal(fusionUpgradeStep({ ...removed, rs: [{ id: "M001", amt: 0 }] },
    data, { ...plan, stage: "start" }), "restore");
  assert.equal(fusionUpgradeStep(removed, data, { ...plan, stage: "restore" }), "restore");
  assert.equal(fusionUpgradeStep(output, data, { ...plan, stage: "restore" }), "equip");
  assert.equal(fusionUpgradeStep(equipped, data, { ...plan, stage: "restore" }), "complete");
});

test("party changes proceed one rerender at a time and retain matching prefix", () => {
  const desired = ["A", "B", "C", "D"];
  assert.deepEqual(nextPartyMove(["D", "X", "B", "A"], desired), { remove: "D" });
  assert.deepEqual(nextPartyMove(["X", "B", "A"], desired), { remove: "X" });
  assert.deepEqual(nextPartyMove(["B", "A"], desired), { add: "C" });
  assert.deepEqual(nextPartyMove(["C", "B", "A"], desired), { add: "D" });
  assert.equal(nextPartyMove(["D", "C", "B", "A"], desired), null);
});

test("playbook dialog waits for opening animation and recovers a stuck closing overlay", () => {
  const timers = [];
  const events = [];
  let inactive = false;
  const dialog = {
    isConnected: true,
    classList: { contains: (name) => name === "dialogInactive" && inactive },
    querySelector: (selector) => selector === ".dialogClose"
      ? { click: () => { inactive = true; } }
      : { dispatchEvent: (event) => events.push(event.type) }
  };
  schedulePlaybookDialogClose(dialog, (callback, delay) => timers.push({ callback, delay }));
  const opening = timers.shift();
  assert.equal(opening.delay, 300);
  assert.equal(inactive, false);
  opening.callback();
  assert.equal(inactive, true);
  const closing = timers.shift();
  assert.equal(closing.delay, 400);
  closing.callback();
  assert.deepEqual(events, ["transitionend"]);
});

test("playbook dialog does not touch an overlay already closed by the player", () => {
  const timers = [];
  const dialog = {
    isConnected: true,
    classList: { contains: () => true },
    querySelector: () => { throw new Error("already closed"); }
  };
  schedulePlaybookDialogClose(dialog, (callback) => timers.push(callback));
  timers[0]();
  assert.equal(timers.length, 1);
});

test("joint assignment may leave an extra hero idle", () => {
  const extra = { ...save, h: { heroes: [...save.h.heroes, {
    id: "H12", hp: 200, owned: true, playbook: "PB1",
    gearSlots: [{ gear: { id: "R1", rarity: 1, sharp: 0 } }]
  }] } };
  const config = { ...fixture, heroes: [...fixture.heroes, {
    ...fixture.heroes[0], id: "H12", name: "候补"
  }] };
  const areas = analyze(extra, config).adventure.areas;
  assert.equal(areas.length, 3);
  assert.equal(new Set(areas.flatMap((area) => area.members.map((hero) => hero.id))).size, 12);
});

test("support and damage tradeoffs depend on team and enemy pressure", () => {
  const heroes = [basicHero("tank", 100, 600),
    basicHero("damage", 120, 100, "Mind"),
    basicHero("other", 80, 100, "Moxie"),
    basicHero("fourth", 90, 100, "Mind")];
  const data = {
    ...fixture,
    playbook: [
      { id: "PB1", name: "输出", skill1: "S1",
        skill2: "S0000", skill3: "S0000", skill4: "S0000" },
      { id: "PB2", name: "治疗", skill1: "S1041",
        skill2: "S0000", skill3: "S0000", skill4: "S0000" }
    ],
    skills: [...fixture.skills, { id: "S1041", powMod: 0,
      description: "为所有队友恢复生命值" }]
  };
  const encounter = { enemies: 3, pow: 900, frontHp: 100000 };
  const selected = bestBooks(save, data, heroes, encounter);
  assert.ok(selected.profiles.some((profile) => profile.book.id === "PB2"));
  assert.ok(selected.sustain > 0);
  const easy = bestBooks(save, data, heroes, { enemies: 1, pow: 1, frontHp: 100 });
  assert.ok(easy.profiles.every((profile) => profile.book.id === "PB1"));
});

test("team attack buff gains value from stronger teammates", () => {
  const support = basicHero("support", 20, 200, "Moxie");
  const data = {
    ...fixture,
    playbook: [
      fixture.playbook[0],
      { id: "PB2", name: "攻击增益", skill1: "S2011",
        skill2: "S0000", skill3: "S0000", skill4: "S0000" }
    ],
    skills: [...fixture.skills, { id: "S2011", powMod: 0.25,
      description: "为所有队友施加情歌，攻击力提高 25%" }]
  };
  const encounter = { enemies: 1, pow: 1, frontHp: 999999 };
  assert.equal(bestBooks(save, data, [support], encounter).profiles[0].book.id, "PB1");
  const allies = [support, ...Array.from({ length: 3 }, (_, i) =>
    basicHero(`ally${i}`, 300, 200))];
  assert.equal(bestBooks(save, data, allies, encounter).profiles[0].book.id, "PB2");
});

test("focus damage can outrank spread damage when it removes the front enemy", () => {
  const heroes = [basicHero("tank", 100, 200)];
  const hard = bestBooks(save, fixture, heroes, { enemies: 4, pow: 500, frontHp: 550 });
  assert.equal(hard.profiles[0].book.id, "PB1");
  const durable = bestBooks(save, fixture, heroes, { enemies: 4, pow: 1, frontHp: 99999 });
  assert.equal(durable.profiles[0].book.id, "PB2");
});

test("damage-over-time and a valid marked target contribute to team synergy", () => {
  const hero = basicHero("support", 100, 200);
  const base = { hero, front: 300, spread: 0, direct: 300, heal: 0,
    healAll: 0, guard: 0, healthBuff: 0, attackBuff: 0, recoil: 0, power: 0 };
  const encounter = { enemies: 4, pow: 100, frontHp: 500 };
  const normal = partyScore([{ ...base }], encounter);
  const effects = partyScore([{ ...base, scorch: true, mark: 2 }], encounter);
  assert.ok(effects.synergy > normal.synergy);
  const invalid = partyScore([{ ...base, mark: 5 }], encounter);
  assert.equal(invalid.synergy, normal.synergy);
});

test("equipment aggregates across four same-type heroes and material-limited quantity", () => {
  const heroes = Array.from({ length: 4 }, (_, i) =>
    basicHero(`H${i}`, 30, 200));
  const adventure = { areas: [{ name: "区域", members: heroes, front: heroes[0] }] };
  const result = equipmentAdvice(save, fixture, heroes, adventure);
  assert.equal(result.plans[0].id, "R3");
  assert.equal(result.plans[0].crafts, 4);
  assert.equal(new Set(result.plans[0].targets.map((target) => target.heroId)).size, 4);
  const limited = equipmentAdvice({ ...save, rs: [{ id: "M1", amt: 2 }] },
    fixture, heroes, adventure);
  assert.equal(limited.plans[0].crafts, 1);
});

test("provided save runs against game-shaped data with three distinct teams", () => {
  const text = fs.readFileSync(path.join(__dirname, "../ForgeAndFortuneSave.txt"), "utf8");
  const provided = JSON.parse(JSON.parse(zlib.gunzipSync(Buffer.from(text, "base64")).toString()));
  const config = {
    ...fixture,
    heroes: provided.h.heroes.map((hero) => ({
      id: hero.id, name: hero.id, type: hero.id.startsWith("H0") ? "Might" : "Mind",
      initialHP: 50, initialPow: 10, playbooks: [hero.playbook],
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
        [`slot${i + 1}Type`, "Swords"]))
    })),
    recipes: provided.r.map(({ id }) => basicRecipe(id)),
    playbook: [...new Set(provided.h.heroes.map((hero) => hero.playbook))]
      .map((id) => ({ id, name: id, skill1: "S0000", skill2: "S0000",
        skill3: "S0000", skill4: "S0000" })),
    dungeons: [1, 2, 3].map((area) => ({
      ...fixture.dungeons[area - 1], id: `D${area}08`
    }))
  };
  const result = analyze(provided, config);
  assert.equal(result.adventure.areas.length, 3);
  assert.equal(new Set(result.adventure.areas.flatMap((area) =>
    area.members.map((hero) => hero.id))).size, 12);
});
