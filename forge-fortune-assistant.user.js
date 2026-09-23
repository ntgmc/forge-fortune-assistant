// ==UserScript==
// @name         Forge & Fortune 战力助手
// @namespace    https://game.itwmw.com/forge-fortune/
// @version      3.2.0
// @description  分析战力并可选自动精通、编队技能与融合
// @match        https://game.itwmw.com/forge-fortune/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const indexById = (items) => new Map((items || []).map((item) => [item.id, item]));
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const num = (value) => Number.isFinite(value) ? value : 0;
  const formatted = (value) => Math.round(value).toLocaleString("zh-CN");

  // Mirrors the game's itemContainer.pow(), hp() and statCalc() for base equipment stats.
  function itemStats(item, recipe, rarityMods) {
    if (!item || !recipe || !Number.isFinite(rarityMods[item.rarity])) return { pow: 0, hp: 0 };
    const multiplier = rarityMods[item.rarity] * (1 + 0.05 * num(item.sharp));
    return {
      pow: Math.floor(num(item.powRatio ?? recipe.pow) * recipe.pts * multiplier),
      hp: Math.floor(9 * num(item.hpRatio ?? recipe.hp) * recipe.pts * multiplier)
    };
  }

  function heroesFromSave(save, data) {
    const recipes = indexById(data.recipes);
    const heroDefs = indexById(data.heroes);
    return (save.h?.heroes || []).filter((hero) => hero.owned).map((hero) => {
      const info = heroDefs.get(hero.id);
      if (!info) return null;
      const gear = (hero.gearSlots || []).map((slot) => slot.gear || null);
      const stats = gear.map((item) => itemStats(item, recipes.get(item?.id), data.misc.rarityMod));
      return {
        id: hero.id, name: info.name, info, gear, playbook: hero.playbook,
        pow: info.initialPow + sum(stats.map((stat) => stat.pow)),
        hp: info.initialHP + sum(stats.map((stat) => stat.hp)),
        currentHp: hero.hp
      };
    }).filter(Boolean);
  }

  function boostAdvice(save, data) {
    const fuel = num(save.ds?.fuel);
    const purchased = new Set((save.sh?.perks || []).filter((perk) => perk.purchased)
      .map((perk) => perk.id));
    const tiers = (data.misc.fuelBoosts || []).map((tier, level) => ({
      ...tier, level, unlocked: purchased.has(tier.perkId),
      hours: fuel / tier.costPerSecond / 3600,
      extraPerFuel: (tier.multiplier - 1) / tier.costPerSecond
    })).filter((tier) => tier.unlocked);
    const adventures = (save.d?.dungeons || []).filter((dungeon) => dungeon.status === 1).length;
    const crafts = (save.as?.slots || []).filter((slot) => slot.status === 1).length;
    const quests = (save.e?.quests || []).filter((quest) => quest.party).length +
      (save.e?.expeditions || []).length;
    const selected = tiers.find((tier) => tier.level === save.ds?.boostLevel) || tiers[0];
    const horizon = 1800;
    const fastest = [...tiers].filter((tier) => tier.costPerSecond * horizon <= fuel)
      .sort((a, b) => b.multiplier - a.multiplier)[0];
    const efficient = [...tiers].sort((a, b) =>
      b.extraPerFuel - a.extraPerFuel || b.multiplier - a.multiplier)[0];
    let recommendation;
    if (!tiers.length) recommendation = "先在市场解锁加速档位。";
    else if (!fuel) recommendation = "精华不足；先分解不需要保留的装备。";
    else if (adventures + crafts + quests === 0) {
      recommendation = "暂不开加速：先安排冒险、制作或远征，再投入精华。";
    } else if (fastest) {
      recommendation = `现在开 ${fastest.multiplier} 倍，持续 30 分钟现实时间（预计消耗 ${formatted(fastest.costPerSecond * horizon)} 精华、获得 ${formatted(fastest.multiplier * horizon / 60)} 分钟游戏进度），然后检查冒险和制作。`;
    } else {
      const seconds = fuel / efficient.costPerSecond;
      recommendation = `精华不足以维持任何已解锁倍率 30 分钟：开 ${efficient.multiplier} 倍（燃料效率最高），约 ${seconds < 60
        ? `${seconds.toFixed(1)} 秒` : `${(seconds / 60).toFixed(1)} 分钟`}后精华耗尽，届时重新评估。`;
    }
    return { fuel, tiers, selected, adventures, crafts, quests,
      fastest, efficient, recommendation };
  }

  const EFFECTS = {
    S0010: { guard: 0.5 }, S0011: { guard: 0.4, front: 1 }, S0012: { guard: 0.25 },
    S0020: { guard: 0.45 }, S0021: { guard: 0.5 }, S0022: { power: 0.1 },
    S0030: { recoil: 0.15 }, S0031: { necrosisHeal: 1 }, S0032: { recoil: 0.15 },
    S0041: { frontFactor: 0.85 }, S0042: { power: 0.15 },
    S1010: { scorch: true }, S1011: { scorch: true }, S1012: { frontFactor: 0.75 },
    S1020: { chill: true }, S1021: { chill: true }, S1022: { guard: 0.6 },
    S1030: { necrosis: true, recoil: 0.07 },
    S1031: { necrosis: true, recoil: 0.07 },
    S1032: { necrosis: true, recoil: 0.25 },
    S1040: { heal: 1 }, S1041: { healAll: 0.75 }, S1042: { regen: 0.7 },
    S2010: { healthBuff: 2 }, S2011: { attackBuff: 0.25 },
    S2012: { vulnerability: 1 },
    S2020: { execute: true }, S2021: { burnCombo: true },
    S2031: { chillCombo: true },
    S2040: { mark: 2 }, S2041: { mark: 3 }, S2042: { mark: 4 }
  };

  function bookProfile(book, hero, skills, enemies) {
    const profile = { hero, book, front: 0, spread: 0, direct: 0, heal: 0,
      healAll: 0, guard: 0, recoil: 0, power: 0, healthBuff: 0, attackBuff: 0,
      chill: false, scorch: false, necrosis: false, chillCombo: false,
      burnCombo: false, necrosisHeal: false, execute: false,
      vulnerability: false, mark: 0 };
    for (const id of [book.skill1, book.skill2, book.skill3, book.skill4]) {
      const skill = skills.get(id);
      if (!skill) continue;
      if (id === "S0000") { profile.front += hero.pow; profile.direct += hero.pow; continue; }
      const effect = EFFECTS[id] || {};
      const text = skill.description || "";
      const dealsDamage = /对.*(?:造成|攻击).*伤害/.test(text);
      const count = /所有敌人|全体敌人/.test(text) ? enemies
        : /两名敌人|两个敌人/.test(text) ? Math.min(enemies, 2) : 1;
      const target = /第二名敌人|第三名敌人|第四名敌人/.test(text) ? 0 : 1;
      const multiplier = id === "S2030" ? 2 : num(skill.powMod);
      const damage = dealsDamage ? hero.pow * multiplier * (effect.frontFactor || 1) : 0;
      profile.front += damage * target;
      profile.direct += damage * count;
      profile.spread += damage * (count - target);
      profile.heal += hero.pow * (num(effect.heal) + num(effect.regen));
      profile.healAll += num(effect.healAll);
      profile.guard += num(effect.guard);
      profile.recoil += num(effect.recoil) * hero.hp;
      profile.power += num(effect.power);
      profile.healthBuff += num(effect.healthBuff) * hero.pow;
      profile.attackBuff += num(effect.attackBuff);
      profile.chill ||= !!effect.chill;
      profile.scorch ||= !!effect.scorch;
      profile.necrosis ||= !!effect.necrosis;
      profile.chillCombo ||= !!effect.chillCombo;
      profile.burnCombo ||= !!effect.burnCombo;
      profile.necrosisHeal ||= !!effect.necrosisHeal;
      profile.execute ||= !!effect.execute;
      profile.vulnerability ||= !!effect.vulnerability;
      profile.mark ||= num(effect.mark);
    }
    return profile;
  }

  function skillOptions(save, data, hero, enemies) {
    const books = indexById(data.playbook);
    const skills = indexById(data.skills);
    const unlocked = new Set((save.pb?.playbookDB || []).filter((book) => book.unlocked)
      .map((book) => book.id));
    const options = (hero.info.playbooks || []).filter((id) =>
      unlocked.has(id) && books.has(id)).map((id) => bookProfile(books.get(id), hero, skills, enemies));
    if (!options.length && books.has(hero.playbook)) {
      options.push(bookProfile(books.get(hero.playbook), hero, skills, enemies));
    }
    return options;
  }

  function partyScore(profiles, encounter) {
    const members = profiles.map((profile) => profile.hero);
    const front = [...members].sort((a, b) => b.hp - a.hp)[0];
    const enemyDamage = encounter.pow * encounter.enemies * 3;
    const hp = sum(members.map((hero) => hero.hp));
    const focus = sum(profiles.map((profile) => profile.front));
    const spread = sum(profiles.map((profile) => profile.spread));
    const direct = sum(profiles.map((profile) => profile.direct));
    const attack = sum(members.map((hero) => hero.pow));
    const heal = Math.min(enemyDamage * 0.75, sum(profiles.map((profile) =>
      profile.heal + profile.hero.pow * profile.healAll * members.length)));
    const guards = Math.min(enemyDamage * 0.6, enemyDamage *
      sum(profiles.map((profile) => profile.guard)) / 3);
    const healthBuff = sum(profiles.map((profile) => profile.healthBuff)) * members.length;
    const attackBuff = attack * sum(profiles.map((profile) => profile.attackBuff)) * 2;
    const recoil = sum(profiles.map((profile) => profile.recoil));
    const chill = profiles.some((profile) => profile.chill);
    const scorch = profiles.some((profile) => profile.scorch);
    const necrosis = profiles.some((profile) => profile.necrosis);
    const mark = profiles.find((profile) => profile.mark > 0 &&
      profile.mark <= encounter.enemies);
    const synergy = (chill ? sum(profiles.filter((p) => p.chillCombo).map((p) => p.hero.pow)) : 0) +
      (scorch ? sum(profiles.filter((p) => p.burnCombo).map((p) => p.hero.pow)) : 0) +
      (necrosis ? sum(profiles.filter((p) => p.necrosisHeal).map((p) => p.hero.pow)) : 0) +
      sum(profiles.filter((p) => p.scorch).map((p) => p.hero.pow * 0.2 *
        (p.spread > 0 ? encounter.enemies : 1))) +
      sum(profiles.filter((p) => p.necrosis).map((p) => p.hero.pow * 0.6)) +
      (mark ? enemyDamage * Math.min(1, attack * 0.45 / Math.max(1, encounter.frontHp)) * 0.15 : 0);
    const killRatio = Math.min(1, focus / Math.max(1, encounter.frontHp));
    const earlyKill = killRatio === 1 ? enemyDamage * 0.45 : enemyDamage * killRatio * 0.12;
    const effectiveGuard = Math.min(enemyDamage, heal + guards + (chill ? enemyDamage * 0.12 : 0));
    const survivalWeight = Math.min(1.3, Math.max(0.35, enemyDamage / Math.max(hp, 1)));
    const tankPenalty = front?.info.type !== "Might" ? enemyDamage * 0.3 : 0;
    const usefulSpread = spread * (encounter.enemies > 1 ? 0.42 : 0);
    const score = focus + usefulSpread + earlyKill + synergy +
      (effectiveGuard + healthBuff * 0.25) * survivalWeight +
      attackBuff * 1.2 + sum(profiles.map((p) => p.power * p.hero.pow)) -
      recoil * survivalWeight - tankPenalty;
    return { score, focus, direct, spread, sustain: effectiveGuard, earlyKill,
      synergy, front, enemies: encounter.enemies, pressure: enemyDamage,
      guards, healing: heal };
  }

  function bestBooks(save, data, members, encounter) {
    const choices = members.map((hero) => skillOptions(save, data, hero, encounter.enemies));
    let best = null;
    const selected = [];
    function search(position) {
      if (position === members.length) {
        const metrics = partyScore(selected, encounter);
        const changes = selected.filter((profile) => profile.book.id !== profile.hero.playbook).length;
        const value = metrics.score - changes * 0.001;
        if (!best || value > best.value) {
          best = { ...metrics, value, profiles: [...selected] };
        }
        return;
      }
      for (const option of choices[position]) {
        selected.push(option);
        search(position + 1);
        selected.pop();
      }
    }
    if (choices.every((options) => options.length)) search(0);
    return best;
  }

  function combinations(count, size) {
    const masks = [];
    function add(start, remaining, mask) {
      if (!remaining) { masks.push(mask); return; }
      for (let i = start; i <= count - remaining; i++) add(i + 1, remaining - 1, mask | (1 << i));
    }
    add(0, size, 0);
    return masks;
  }

  // Bounded deterministic combat projection: the game has additional random, rune and equipment effects.
  function simulateFloor(profiles, def, mobDefs, skills, floor) {
    if (!mobDefs?.length || mobDefs.some((mob) => !mob) || !Number.isFinite(def.hp)) return null;
    const baseHp = def.hp + 10 * (floor - 1) * num(def.hpGain);
    const basePow = def.pow + 10 * (floor - 1) * num(def.powGain);
    const enemies = mobDefs.map((mob) => ({
      id: mob.id, hp: Math.max(1, Math.floor(baseHp * num(mob.hpMod))),
      maxHp: Math.max(1, Math.floor(baseHp * num(mob.hpMod))),
      pow: Math.floor(basePow * num(mob.powMod)), skills: [mob.skill1, mob.skill2, mob.skill3, mob.skill4],
      phase: false, evade: 0
    }));
    const heroes = profiles.map((profile) => ({
      hp: profile.hero.hp, maxHp: profile.hero.hp, pow: profile.hero.pow,
      skills: [profile.book.skill1, profile.book.skill2, profile.book.skill3, profile.book.skill4]
    }));
    let turns = 0;
    for (let round = 0; round < 100; round++) {
      let guard = 0;
      let damageBuff = 0;
      for (let index = 0; index < Math.max(heroes.length, enemies.length); index++) {
        const hero = heroes[index];
        if (hero?.hp > 0 && enemies.some((enemy) => enemy.hp > 0)) {
          turns++;
          const id = hero.skills[round % 4];
          const skill = skills.get(id);
          const effect = EFFECTS[id] || {};
          const text = skill?.description || "";
          const power = Math.floor(hero.pow * (id === "S0000" ? 1 : num(skill?.powMod)));
          if (effect.heal || effect.regen || effect.healAll) {
            const targets = effect.healAll ? heroes.filter((member) => member.hp > 0) :
              [heroes.filter((member) => member.hp > 0)
                .sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp))[0]];
            for (const target of targets) {
              target.hp = Math.min(target.maxHp, target.hp +
                Math.floor(hero.pow * (effect.healAll || effect.heal || effect.regen)));
            }
          }
          guard = Math.max(guard, num(effect.guard));
          damageBuff = Math.max(damageBuff, num(effect.attackBuff));
          if (id === "S0000" || /对.*(?:造成|攻击).*伤害/.test(text)) {
            const alive = enemies.filter((enemy) => enemy.hp > 0);
            const count = /所有敌人|全体敌人/.test(text) ? alive.length :
              /两名敌人|两个敌人/.test(text) ? Math.min(2, alive.length) : 1;
            for (const enemy of alive.slice(0, count)) {
              if (enemy.phase) continue;
              if (enemy.evade > 0) { enemy.evade--; continue; }
              enemy.hp = Math.max(0, enemy.hp -
                Math.floor(power * (effect.frontFactor || 1) * (1 + damageBuff)));
            }
          }
        }
        if (enemies.every((enemy) => enemy.hp <= 0)) {
          return { cleared: true, turns, remaining: sum(heroes.map((member) => member.hp)) };
        }
        const enemy = enemies[index];
        if (!enemy || enemy.hp <= 0) continue;
        turns++;
        enemy.phase = false;
        const id = enemy.skills[round % 4];
        const skill = skills.get(id);
        const power = Math.floor(enemy.pow * (id === "S0000" ? 1 : num(skill?.powMod)));
        if (id === "SM205") enemy.phase = true;
        else if (id === "SM208") {
          for (const ally of enemies) if (ally.hp > 0) ally.evade++;
        } else if (id === "SM203") {
          const target = [...enemies].filter((ally) => ally.hp > 0)
            .sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp))[0];
          if (target) target.hp = Math.min(target.maxHp, target.hp + power);
        } else if (id === "S0000" || /对.*(?:造成|攻击).*伤害/.test(skill?.description || "")) {
          const targets = id === "SM204" || /所有敌人|全体敌人/.test(skill?.description || "") ?
            heroes.filter((member) => member.hp > 0) : heroes.filter((member) => member.hp > 0).slice(0, 1);
          for (const target of targets) target.hp = Math.max(0, target.hp -
            Math.floor(power * (1 - Math.min(0.8, guard))));
        }
        if (heroes.every((member) => member.hp <= 0)) return { cleared: false, turns, remaining: 0 };
      }
    }
    return { cleared: false, turns, remaining: sum(heroes.map((member) => member.hp)) };
  }

  function simulateDungeon(profiles, def, mobs, skills, limit = 8) {
    const mobDefs = [def.mob1, def.mob2, def.mob3, def.mob4].filter(Boolean)
      .map((id) => mobs.get(id));
    let floors = 0;
    let last = null;
    for (let floor = 1; floor <= limit; floor++) {
      last = simulateFloor(profiles, def, mobDefs, skills, floor);
      if (!last?.cleared) break;
      floors++;
    }
    return { floors, remaining: last?.remaining || 0, complete: last !== null };
  }

  function adventureAdvice(save, data, heroes) {
    const states = indexById(save.d?.dungeons);
    const purchased = new Set((save.sh?.perks || []).filter((perk) => perk.purchased).map((perk) => perk.id));
    const mobs = indexById(data.mobs);
    const skills = indexById(data.skills);
    const areas = ["D1", "D2", "D3"].map((prefix) => {
      const choices = data.dungeons.filter((def) => def.id.startsWith(prefix) &&
        def.type === "dungeon" && states.has(def.id) &&
        (states.get(def.id).maxFloor > 0 || states.get(def.id).status === 1 ||
          (def.unlockedBy?.startsWith("AL") ? purchased.has(def.unlockedBy) :
            states.get(def.unlockedBy)?.maxFloor > 0)))
        .sort((a, b) => Number(b.id.slice(-2)) - Number(a.id.slice(-2)));
      const running = (save.d?.dungeons || []).find((entry) =>
        entry.id.startsWith(prefix) && entry.status === 1);
      const current = running?.party?.heroID || [];
      return choices.map((def) => ({
        id: def.id, name: def.name, state: states.get(def.id), def, running, current,
        size: def.partySize, tier: Number(def.id.slice(-2)),
        encounter: {
          enemies: [def.mob1, def.mob2, def.mob3, def.mob4].filter(Boolean).length,
          pow: def.pow, frontHp: def.hp * (mobs.get(def.mob1)?.hpMod ?? 1)
        }
      }));
    });
    if (areas.some((area) => !area.length) ||
        heroes.length < sum(areas.map((area) => area[0].size)) || heroes.length > 15) {
      return { areas: [], reason: "需要三个已开放区域和足够的英雄才能计算互不冲突的分队。" };
    }
    const candidate = areas.map((variants) => {
      const results = new Map();
      for (const area of variants) {
        if ([area.def.mob1, area.def.mob2, area.def.mob3, area.def.mob4]
          .filter(Boolean).some((id) => !mobs.has(id))) continue;
        const preliminary = combinations(heroes.length, area.size).map((mask) => {
          const members = heroes.filter((_, index) => mask & (1 << index));
          const optimized = bestBooks(save, data, members, area.encounter);
          return optimized && { ...area, mask, members, ...optimized };
        }).filter(Boolean);
        for (const entry of preliminary) {
          const simulation = simulateDungeon(entry.profiles, entry.def, mobs, skills);
          if (simulation.complete && simulation.floors >= 1) {
            const result = { ...entry, simulation,
              value: simulation.floors * 1e6 + entry.tier * 1000 +
                simulation.remaining / Math.max(1, sum(entry.members.map((member) => member.hp))) };
            if (!results.has(entry.mask) || results.get(entry.mask).value < result.value) {
              results.set(entry.mask, result);
            }
          }
        }
      }
      return [...results.values()];
    });
    if (candidate.some((entries) => !entries.length)) {
      return { areas: [], reason: "至少有一个区域没有模拟通过首层的候选队伍；自动编队已暂停。请核对装备、解锁和模拟数据。" };
    }
    const full = (1 << heroes.length) - 1;
    const bestThird = Array(1 << heroes.length).fill(null);
    for (const entry of candidate[2]) bestThird[entry.mask] = entry;
    for (let mask = 1; mask <= full; mask++) {
      for (let bit = 0; bit < heroes.length; bit++) {
        if (!(mask & (1 << bit))) continue;
        const subset = bestThird[mask ^ (1 << bit)];
        if (subset && (!bestThird[mask] || subset.value > bestThird[mask].value)) {
          bestThird[mask] = subset;
        }
      }
    }
    let optimal = null;
    for (const first of candidate[0]) {
      for (const second of candidate[1]) {
        if (first.mask & second.mask) continue;
        const third = bestThird[full ^ (first.mask | second.mask)];
        if (!third) continue;
        const total = first.value + second.value + third.value;
        if (!optimal || total > optimal.total) optimal = { total, entries: [first, second, third] };
      }
    }
    if (!optimal) return { areas: [], reason: "未找到三个区域互不冲突且均模拟通过首层的队伍；自动编队已暂停。" };
    return { areas: areas.map((area, index) => {
      const entry = optimal.entries[index];
      const ordered = [entry.front, ...entry.members.filter((hero) => hero !== entry.front)];
      return { ...entry, members: ordered,
        changed: ordered.filter((hero) => !entry.current.includes(hero.id)) };
    }), total: optimal.total };
  }

  function skillAdvice(adventure) {
    return adventure.areas.flatMap((area) => area.profiles.map((profile) => ({
      area: area.name, hero: profile.hero.name, book: profile.book.name,
      current: profile.hero.playbook === profile.book.id, front: profile.front,
      direct: profile.direct, heal: profile.heal, guard: profile.guard,
      synergy: area.synergy, description: [profile.book.skill1, profile.book.skill2,
        profile.book.skill3, profile.book.skill4].filter((id) => id !== "S0000")
    })));
  }

  function equipmentAdvice(save, data, heroes, adventure) {
    const owned = indexById(save.r);
    const recipes = indexById(data.recipes);
    const materials = indexById(data.materials);
    const resources = indexById(save.rs);
    const queue = new Set((save.as?.slots || []).filter((slot) => slot.status === 1)
      .map((slot) => slot.itemid));
    const assignments = new Map(adventure.areas.flatMap((area) =>
      area.members.map((hero, index) => [hero.id, { area: area.name, front: index === 0 }])));
    const groups = new Map();
    const inventory = [];
    for (const hero of heroes) {
      for (let slot = 0; slot < 6; slot++) {
        const type = hero.info[`slot${slot + 1}Type`];
        if (!type) continue;
        const equipped = hero.gear[slot];
        const rarity = equipped?.rarity ?? 0;
        const base = itemStats(equipped, recipes.get(equipped?.id), data.misc.rarityMod);
        const role = assignments.get(hero.id);
        const weight = role?.front ? 1.3 : 1;
        const gain = (candidate) => {
          const pow = candidate.pow - base.pow;
          const hp = candidate.hp - base.hp;
          if (pow < 0 || hp < 0 || (!pow && !hp)) return null;
          return { hero: hero.name, heroId: hero.id, area: role?.area || "未分配",
            rarity, pow, hp, score: pow + hp / 9 * weight };
        };
        for (const item of save.i || []) {
          const recipe = recipes.get(item.id);
          if (!recipe || recipe.type !== type || !item.qty) continue;
          const improvement = gain(itemStats(item, recipe, data.misc.rarityMod));
          if (improvement) inventory.push({ ...improvement, name: recipe.name, qty: item.qty });
        }
        for (const recipe of data.recipes) {
          if (!recipe.canForge || !owned.get(recipe.id)?.owned ||
              recipe.type !== type || recipe.id === equipped?.id) continue;
          const improvement = gain(itemStats({ rarity, sharp: 0 }, recipe, data.misc.rarityMod));
          if (!improvement) continue;
          if (!groups.has(recipe.id)) {
            const costs = Object.entries(recipe.mcost || {}).map(([id, need]) => ({
              id, name: materials.get(id)?.name || id, need, have: num(resources.get(id)?.amt)
            }));
            const capacity = Math.min(4, ...costs.filter((cost) => cost.need > 0)
              .map((cost) => Math.floor(cost.have / cost.need)));
            groups.set(recipe.id, { id: recipe.id, name: recipe.name, type,
              costs, capacity, queued: queue.has(recipe.id), targets: [], time: recipe.craftTime });
          }
          groups.get(recipe.id).targets.push(improvement);
        }
      }
    }
    const plans = [...groups.values()].map((group) => {
      group.targets.sort((a, b) => b.score - a.score);
      group.targets = group.targets.slice(0, 4);
      group.crafts = Math.min(group.targets.length, group.capacity);
      group.total = sum(group.targets.slice(0, group.crafts).map((target) => target.score));
      return group;
    }).filter((group) => group.crafts > 0)
      .sort((a, b) => b.total - a.total || a.time - b.time);
    inventory.sort((a, b) => b.score - a.score);
    return { plans, inventory };
  }

  function analyze(save, data) {
    if (!Array.isArray(save?.h?.heroes) || !Array.isArray(save?.d?.dungeons) ||
        !Array.isArray(data?.recipes) || !Array.isArray(data.heroes) ||
        !Array.isArray(data.dungeons) || !Array.isArray(data.mobs) || !Array.isArray(data.playbook) ||
        !Array.isArray(data.skills) || !Array.isArray(data.materials) ||
        !Array.isArray(data.misc?.rarityMod)) {
      throw new Error("存档或游戏配置缺少战力分析所需字段");
    }
    const heroes = heroesFromSave(save, data);
    const adventure = adventureAdvice(save, data, heroes);
    return {
      boost: boostAdvice(save, data), adventure,
      skills: skillAdvice(adventure),
      equipment: equipmentAdvice(save, data, heroes, adventure),
      craftingFull: Number.isInteger(save.as?.maxSlots) &&
        (save.as?.slots || []).length >= save.as.maxSlots
    };
  }

  function freeMastery(save, data) {
    const owned = indexById(save.r);
    return data.recipes.filter((recipe) => {
      const progress = owned.get(recipe.id);
      return progress?.owned && !progress.mastered && recipe.recipeType === "normal" &&
        progress.craftCount >= recipe.minCraft &&
        Math.max(0, recipe.masteryTotal -
          recipe.masteryAmt * (progress.craftCount - recipe.minCraft)) === 0;
    }).map((recipe) => recipe.id);
  }

  function fusionCandidates(save, data) {
    const recipes = indexById(data.recipes);
    const gold = (save.rs || []).find((resource) => resource.id === "M001")?.amt || 0;
    return (save.i || []).filter((item) => {
      const recipe = recipes.get(item.id);
      return item.qty >= 4 && item.rarity < data.misc.rarityMod.length - 1 &&
        recipe?.recipeType === "normal" && recipe.type !== "Trinkets" &&
        Number.isFinite(recipe.value) && gold >= 4 * recipe.value * (item.rarity + 1);
    }).map((item) => ({
      id: item.id, rarity: item.rarity, qty: item.qty,
      uniqueID: `${item.id}_${item.rarity}_${item.sharp}_${item.rune}_${(
        item.powRatio !== recipes.get(item.id).pow || item.hpRatio !== recipes.get(item.id).hp
      ) ? "1" : "0"}`
    }));
  }

  function fusionHasSlot(save) {
    const perks = new Set((save.sh?.perks || []).filter((perk) => perk.purchased)
      .map((perk) => perk.id));
    const maxSlots = perks.has("AL3012") ? 4 : perks.has("AL3006") ? 3 : 2;
    return (save.fb?.slots || []).length < maxSlots;
  }

  function nextPartyMove(current, desired) {
    const kept = [...current].reverse();
    if (kept.length > desired.length || kept.some((hero, index) => desired[index] !== hero)) {
      return { remove: current[0] };
    }
    return kept.length < desired.length ? { add: desired[kept.length] } : null;
  }

  function schedulePlaybookDialogClose(dialog, schedule = setTimeout) {
    if (!dialog) return;
    schedule(() => {
      if (!dialog.isConnected || dialog.classList.contains("dialogInactive")) return;
      dialog.querySelector(".dialogClose")?.click();
      schedule(() => {
        if (!dialog.isConnected || !dialog.classList.contains("dialogInactive")) return;
        dialog.querySelector(".dialogContent.dialogClosing")
          ?.dispatchEvent(new Event("transitionend", { bubbles: true }));
      }, 400);
    }, 300);
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { itemStats, heroesFromSave, boostAdvice, adventureAdvice,
      skillAdvice, equipmentAdvice, analyze, partyScore, bestBooks, freeMastery,
      fusionCandidates, fusionHasSlot, nextPartyMove, schedulePlaybookDialogClose,
      simulateDungeon, simulateFloor };
  }
  if (typeof document === "undefined" || !location.pathname.startsWith("/forge-fortune")) return;

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; position: fixed; z-index: 2147483647; right: 14px; bottom: 14px;
      color: #ecf2f0; font: 13px/1.5 system-ui, sans-serif; letter-spacing: 0; }
    * { box-sizing: border-box; } button { cursor: pointer; font: inherit; }
    .toggle { display: block; margin-left: auto; border: 1px solid #74a8a1; border-radius: 4px;
      background: #175148; color: white; padding: 8px 12px; }
    .panel { width: min(490px, calc(100vw - 24px)); max-height: min(76vh, 740px);
      overflow: auto; margin-bottom: 8px; border: 1px solid #617574; border-radius: 6px;
      background: #1e2929; box-shadow: 0 12px 30px #0009; }
    .panel[hidden] { display: none; }
    header { position: sticky; top: 0; z-index: 2; background: #293738;
      padding: 10px 12px; border-bottom: 1px solid #526662; }
    h2 { margin: 0 0 7px; font-size: 15px; } h3 { margin: 0 0 5px; font-size: 14px; }
    .controls, nav, .auto-controls { display: flex; flex-wrap: wrap; gap: 5px; }
    .auto-controls { margin-top: 7px; gap: 5px 12px; }
    .auto-controls label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    .auto-controls input { accent-color: #78c9a7; }
    .controls button, nav button { border: 1px solid #637d79; border-radius: 4px;
      background: #364b49; color: white; padding: 5px 9px; }
    button:focus-visible { outline: 2px solid #facd76; }
    nav { margin-top: 9px; } nav button[aria-selected="true"] {
      background: #17665c; border-color: #82cfc1; }
    .status, .notice { margin: 0; padding: 9px 12px; border-bottom: 1px solid #435655; }
    .status { color: #bfd1cc; } .notice { color: #f4d38f; background: #303732; }
    .error { color: #ffc1a3; } article { padding: 10px 12px; border-bottom: 1px solid #384c49; }
    article:last-child { border-bottom: 0; } p { margin: 4px 0; }
    .muted { color: #b9c9c5; } .positive { color: #a8e1bb; } .warn { color: #f3cf92; }
    @media (max-width: 520px) { :host { right: 12px; bottom: 12px; }
      .panel { max-height: 65vh; } }
  `;
  root.append(style);
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = "战力助手 ▾";
  toggle.title = "展开或收起战力助手";
  const panel = document.createElement("section");
  panel.className = "panel";
  const header = document.createElement("header");
  const heading = document.createElement("h2");
  heading.textContent = "Forge & Fortune · 战力助手";
  const controls = document.createElement("div");
  controls.className = "controls";
  const live = document.createElement("button");
  live.textContent = "实时存档";
  const refreshButton = document.createElement("button");
  refreshButton.textContent = "刷新";
  const importButton = document.createElement("button");
  importButton.textContent = "导入存档文件";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".txt,text/plain";
  file.hidden = true;
  controls.append(live, refreshButton, importButton, file);
  const nav = document.createElement("nav");
  const tabs = ["加速", "冒险", "技能", "装备"];
  let tab = 0;
  tabs.forEach((label, index) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.setAttribute("aria-selected", String(index === tab));
    button.addEventListener("click", () => {
      tab = index;
      [...nav.children].forEach((child, position) =>
        child.setAttribute("aria-selected", String(position === tab)));
      render();
    });
    nav.append(button);
  });
  const autoControls = document.createElement("div");
  autoControls.className = "auto-controls";
  let autoSettings = {};
  try { autoSettings = JSON.parse(localStorage.getItem("ffa-auto-v1") || "{}") || {}; }
  catch { autoSettings = {}; }
  const automation = {};
  for (const [key, label] of [["mastery", "免费精通"], ["party", "编队与技能"], ["fusion", "重复装备融合"]]) {
    const option = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = autoSettings[key] === true;
    automation[key] = input;
    input.addEventListener("change", () => {
      autoSettings[key] = input.checked;
      localStorage.setItem("ffa-auto-v1", JSON.stringify(autoSettings));
      runAutomation();
    });
    option.append(input, document.createTextNode(`自动${label}`));
    autoControls.append(option);
  }
  header.append(heading, controls, nav, autoControls);
  const status = document.createElement("div");
  status.className = "status";
  const actionStatus = document.createElement("div");
  actionStatus.className = "status";
  actionStatus.textContent = "仅在实时存档模式及游戏对应界面打开时执行自动操作。";
  const body = document.createElement("div");
  panel.append(header, status, actionStatus, body);
  root.append(panel, toggle);
  document.body.append(host);
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.textContent = panel.hidden ? "战力助手 ▴" : "战力助手 ▾";
  });

  let snapshot = null;
  let source = "实时存档";
  let config = null;
  let report = null;
  const attemptedMastery = new Set();
  const attemptedFusion = new Set();
  const visible = (element) => element && element.getClientRects().length > 0;
  const gameData = (element, key) => window.jQuery?.(element).data(key);
  const action = (message) => {
    actionStatus.className = "status";
    actionStatus.textContent = message;
  };

  function applyPartyPlan(save) {
    const teamView = document.querySelector("#areaTeamSelect");
    const selectedDungeon = document.querySelector("#dtsDungeons .dtsHighlight");
    if (!visible(teamView) || !selectedDungeon || !window.jQuery ||
        document.querySelector("#dialogContainer")) return false;
    const id = gameData(selectedDungeon, "dungeonID");
    const area = analyze(save, config).adventure.areas.find((entry) => entry.id === id && !entry.running);
    if (!area) return false;
    const desired = area.members.map((hero) => hero.id);
    const selected = [...document.querySelectorAll("#dungeonTeamCollection .partyCardClick")];
    const current = selected.map((card) => gameData(card, "heroID"));
    const available = [...document.querySelectorAll("#dtsBottom .dungeonAvailableCollection .partyCardClick")]
      .filter((card) => !card.closest(".partyNoClick") && !card.closest(".shadowed"));
    if (desired.some((hero) => !current.includes(hero) &&
        !available.some((card) => gameData(card, "heroID") === hero))) {
      action(`${area.id}：推荐英雄尚未全部空闲，暂不调整编队。`);
      return false;
    }
    const move = nextPartyMove(current, desired);
    if (move) {
      if (move.remove) {
        selected[0].click();
        action(`${area.id}：正在清理旧编队，尚未出发。`);
        return true;
      }
      const card = available.find((entry) => gameData(entry, "heroID") === move.add);
      if (!card) return false;
      card.click();
      action(`${area.id}：正在套用推荐编队，尚未出发。`);
      return true;
    }
    for (const profile of area.profiles) {
      const icon = [...document.querySelectorAll("#dungeonTeamCollection .heroPlaybook")]
        .find((entry) => gameData(entry, "heroID") === profile.hero.id);
      if (!icon || icon.getAttribute("data-tooltip-value") === profile.book.id) continue;
      icon.click();
      const option = [...document.querySelectorAll("#dialogContainer .playbookSelectable")]
        .find((entry) => gameData(entry, "hid") === profile.hero.id &&
          gameData(entry, "pbid") === profile.book.id);
      if (!option) {
        schedulePlaybookDialogClose(document.querySelector("#dialogContainer"));
        action(`${profile.hero.name}：剧本不可选，已跳过。`);
        return true;
      }
      const dialog = document.querySelector("#dialogContainer");
      try {
        option.click();
      } finally {
        schedulePlaybookDialogClose(dialog);
      }
      action(`${profile.hero.name}：已在出发前选择 ${profile.book.name}。`);
      return true;
    }
    return false;
  }

  function runAutomation() {
    if (!config || !Object.values(automation).some((input) => input.checked)) return;
    if (snapshot !== null) {
      action("导入存档仅供分析，自动操作已暂停。");
      return;
    }
    try {
      if (document.querySelector("#dialogContainer")) return;
      const text = localStorage.getItem("ffgs1");
      if (!text) return;
      const save = parseSave(text);
      if (automation.mastery.checked) {
        const eligible = new Set(freeMastery(save, config));
        const button = [...document.querySelectorAll(".recipeMasteryGuildButton, .recipeMasteredStatus")]
          .find((entry) => visible(entry) && eligible.has(gameData(entry, "rid")) &&
            !entry.classList.contains("isMastered") &&
            !attemptedMastery.has(gameData(entry, "rid")));
        if (button) {
          const id = gameData(button, "rid");
          attemptedMastery.add(id);
          button.click();
          action(`已执行免费精通：${indexById(config.recipes).get(id).name}。`);
          return;
        }
      }
      if (automation.party.checked && applyPartyPlan(save)) return;
      if (automation.fusion.checked && fusionHasSlot(save)) {
        const eligible = fusionCandidates(save, config);
        const button = [...document.querySelectorAll("#fuseList .fuseStart")]
          .find((entry) => visible(entry) && eligible.some((item) =>
            item.uniqueID === entry.getAttribute("uniqueid") &&
            !attemptedFusion.has(`${item.uniqueID}_${item.qty}`)));
        if (button) {
          const item = eligible.find((entry) => entry.uniqueID === button.getAttribute("uniqueid"));
          attemptedFusion.add(`${item.uniqueID}_${item.qty}`);
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
          action(`已安排融合 ${item.id}（品质 ${item.rarity}），至少保留一件库存。`);
        }
      }
    } catch (error) {
      action(`自动操作暂停：${error.message}`);
      actionStatus.className = "status error";
    }
  }
  const line = (parent, text, className = "") => {
    const element = document.createElement("p");
    element.className = className;
    element.textContent = text;
    parent.append(element);
  };
  const section = (title, lines) => {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = title;
    article.append(heading);
    lines.forEach(([text, className]) => line(article, text, className));
    body.append(article);
  };
  const notice = (text) => {
    const element = document.createElement("p");
    element.className = "notice";
    element.textContent = text;
    body.append(element);
  };

  function render() {
    if (!report) return;
    body.replaceChildren();
    if (tab === 0) {
      const boost = report.boost;
      notice(boost.recommendation);
      section("精华与任务", [
        [`精华 ${formatted(boost.fuel)} · 冒险 ${boost.adventures} · 制作 ${boost.crafts} · 远征 ${boost.quests}`, ""],
        ["存档不保存加速开关状态；请在游戏中确认开关。", "muted"]
      ]);
      if (boost.fastest && boost.efficient?.level !== boost.fastest.level) {
        line(body, `节省精华的备选：${boost.efficient.multiplier} 倍，每精华额外获得 ${boost.efficient.extraPerFuel.toFixed(2)} 秒进度；当前建议优先提高现实时间内的推进速度。`, "status");
      }
      for (const tier of boost.tiers) section(`${tier.multiplier} 倍 · ${tier.costPerSecond} 精华/现实秒`, [
        [`可维持约 ${tier.hours.toFixed(1)} 小时现实时间；每精华额外产生 ${tier.extraPerFuel.toFixed(2)} 秒游戏进度`, ""],
        [tier.level === boost.selected?.level ? "存档中选中的档位" : "已解锁档位",
          tier.level === boost.selected?.level ? "positive" : "muted"]
      ]);
    } else if (tab === 1) {
      const adventure = report.adventure;
        notice(adventure.areas.length
          ? "按预计通关层数总和分配三个区域，难度可回退；每区至少模拟通过首层才推荐。进行中不能调整技能，调整队伍会重置进度。"
        : adventure.reason);
      for (const area of adventure.areas) {
        const members = [area.front, ...area.members.filter((hero) => hero !== area.front)];
          section(`${area.name} · ${area.id} · 预计通过 ${area.simulation.floors} 层（最多模拟 8 层）`, [
            [`${area.running ? `正在进行 ${area.running.id}，下次出发推荐` : "出发推荐"}：${members.map((hero) => hero.name).join(" → ")}`, "positive"],
          [`较当前队伍需换入：${area.changed.map((hero) => hero.name).join("、") || "无"}`, ""],
          [`前排集火 ${formatted(area.focus)} · 多目标溢出伤害 ${formatted(area.spread)} · 估计敌方压力 ${formatted(area.pressure)}`, "muted"],
          [`治疗约 ${formatted(area.healing)} · 减伤/控场约 ${formatted(area.guards)} · 提前击杀收益约 ${formatted(area.earlyKill)}${area.synergy ? ` · 状态联动约 ${formatted(area.synergy)}` : ""}`, "muted"]
        ]);
      }
        line(body, "回合模拟使用怪物配置、技能与生命倍率；装备特效、符文、随机效果和部分状态未完整还原，不保证实际通关。", "status");
    } else if (tab === 2) {
        notice("各区域为下次出发联动选择已解锁技能，并以回合模拟检验队伍；开打后技能无法调整。");
      for (const area of report.adventure.areas) {
          section(`${area.name} · ${area.id} · 下次出发技能组合${area.running ? "（当前战斗已锁定）" : ""}`, [
          ...area.profiles.map((profile) => [
            `${profile.hero.name}：${profile.book.name}${profile.book.id === profile.hero.playbook
                ? "（当前配置）" : "（出发前切换）"} · ${[
              profile.heal || profile.healAll ? "恢复" : "",
              profile.guard ? "保护" : "",
              profile.healthBuff || profile.attackBuff ? "增益" : "",
              profile.chill || profile.scorch || profile.necrosis || profile.mark ? "控场/状态" : "",
              profile.spread ? "群伤" : "",
              profile.front ? "集火" : ""
            ].filter(Boolean).join("、") || "辅助"}`,
            profile.book.id === profile.hero.playbook ? "muted" : "positive"
          ]),
          [`本队：前排集火 ${formatted(area.focus)}，治疗 ${formatted(area.healing)}，减伤/控场 ${formatted(area.guards)}；敌人 ${area.encounter.enemies} 名。`, "muted"]
        ]);
      }
      line(body, "推荐方案由队伍整体得分决定，个人技能不应脱离区域队友单独比较；无法从存档还原的随机和敌方技能未计入。", "status");
    } else {
      const { plans, inventory } = report.equipment;
      const best = plans[0];
      notice(best ? `优先制作 ${best.name}（${best.type}）：材料可支持 ${best.crafts} 件，同类型四人累计基础战力约 +${best.total.toFixed(1)}。${report.craftingFull
        ? "制作栏已满，先等空位。" : ""}` : "当前没有可用材料支持的同品质双属性升级配方。");
      if (inventory[0]) section("库存先用", [[`${inventory[0].name} → ${inventory[0].hero}，现有装备可提升 ${inventory[0].score.toFixed(1)} 分；更换冒险队员前需处理当前进度。`, "positive"]]);
      for (const plan of plans.slice(0, 8)) {
        section(`${plan.name} · ${plan.type} · ${plan.crafts} 件累计 +${plan.total.toFixed(1)}`, [
          [`分配：${plan.targets.slice(0, plan.crafts).map((target) =>
            `${target.hero}（${target.area}，品质 ${target.rarity}，+${target.score.toFixed(1)}）`).join("、")}`, ""],
          [`材料/件：${plan.costs.map((cost) =>
            `${cost.name} ${formatted(cost.need)} / 库存 ${formatted(cost.have)}`).join("、") || "无"}${plan.queued
            ? " · 同配方制作中" : ""}`, "muted"]
        ]);
      }
      line(body, "同品质、无强化的新装备与当前穿戴装备比较；随机产出的品质、强化与装备特效未计入。累计增益受库存材料和同职业最多四人限制，不是制作期望收益。", "status");
    }
  }

  function parseSave(text) {
    const parsed = JSON.parse(text);
    const save = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    if (!save || typeof save !== "object" || ![0, 1, 2].includes(save.ver)) {
      throw new Error("不支持的存档格式或版本");
    }
    return save;
  }
  async function parseExport(text) {
    const encoded = text.trim();
    if (encoded.startsWith("{") || encoded.startsWith('"')) return parseSave(encoded);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    if (typeof DecompressionStream === "undefined") {
      if (!window.pako) throw new Error("此浏览器不支持 gzip 解压");
      return parseSave(window.pako.ungzip(bytes, { to: "string" }));
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return parseSave(await new Response(stream).text());
  }
  async function loadConfig() {
    if (config) return config;
    const keys = ["recipes", "materials", "heroes", "dungeons", "mobs", "playbook", "skills", "misc"];
    const values = await Promise.all(keys.map(async (key) => {
      const response = await fetch(new URL(`json/${key}.json`, `${location.origin}/forge-fortune/`));
      if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
      return response.json();
    }));
    config = Object.fromEntries(keys.map((key, index) =>
      [key, key === "misc" ? values[index][0] : values[index]]));
    return config;
  }
  async function refresh() {
    try {
      const text = snapshot ?? localStorage.getItem("ffgs1");
      if (!text) throw new Error("未找到游戏存档；可加载预置导出文件。");
      const save = parseSave(text);
      report = analyze(save, await loadConfig());
      status.className = "status";
      status.textContent = `${source} · ${Number.isFinite(save.saveTime)
        ? new Date(save.saveTime).toLocaleString("zh-CN") : "时间未知"}`;
      render();
    } catch (error) {
      report = null;
      body.replaceChildren();
      status.className = "status error";
      status.textContent = `分析失败：${error.message}`;
    }
  }
  live.addEventListener("click", () => { snapshot = null; source = "实时存档"; refresh(); });
  refreshButton.addEventListener("click", refresh);
  importButton.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    if (!file.files?.[0]) return;
    try {
      snapshot = JSON.stringify(await parseExport(await file.files[0].text()));
      source = file.files[0].name;
      await refresh();
    } catch (error) {
      status.className = "status error";
      status.textContent = `导入失败：${error.message}`;
    }
    file.value = "";
  });
  refresh();
  setInterval(runAutomation, 1500);
  setInterval(() => { if (snapshot === null && !panel.hidden) refresh(); }, 10000);
})();
