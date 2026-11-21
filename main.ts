// Sokoban solver for make.fun sokoban-solver-01: push-optimal A* per room.
//
// The levels are a one-wide hallway with small rooms off it; a box pushed into the hallway can never be pushed
// back, so the rooms are independent sub-problems and the level's push optimum is the sum of the rooms'. This
// solver finds that structure from the level itself (dead squares in the player's row cut the floor into
// components), then solves each room with A* over pushes:
//
//   - a state is the boxes' squares plus the player's reachable region (named by its lowest square);
//   - the cost is pushes, and the estimate is a min-cost matching of boxes to goals over pull-distances —
//     the pull-distance of a square is the fewest pushes that bring a lone box from it to a goal (other boxes
//     ignored), precomputed by reverse search from every goal;
//   - pushes onto dead squares (no pull path to any goal) and into a frozen 2x2 block are pruned, so the search
//     never spends its budget on positions no push can save.
//
// A level that does not split into rooms is searched whole. The budget is counted in expansions, never the
// clock, and every tie breaks by a fixed order, so two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets, in A* expansions: one room's search, and the whole set's. */
const ROOM_EXPANSIONS = 350_000;
const SET_EXPANSIONS = 1_800_000;

/** The four directions: [dx, dy, the walk letter, the push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse an XSB level. Short rows pad as walls; the outer frame is forced to wall so index maths stays in range. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

const INF = 1e9;

/**
 * Pull-distances: dist[g][x] is the fewest pushes that bring a lone box from square x to goal g, ignoring the
 * other boxes (a push from x along d needs x+d open for the box and x-d open for the player to stand on).
 * Reverse breadth-first search from each goal. INF where no push sequence reaches the goal: a dead square.
 */
function pullDistances(w: number, wall: Uint8Array, goals: number[]): Int32Array[] {
  return goals.map((goal) => {
    const dist = new Int32Array(wall.length).fill(INF);
    dist[goal] = 0;
    const queue = [goal];
    for (let qi = 0; qi < queue.length; qi++) {
      const y = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const x = y - d; // a box on x pushed along d lands on y; the player stood on x - d
        if (wall[x] || wall[x - d] || dist[x] !== INF) continue;
        dist[x] = dist[y]! + 1;
        queue.push(x);
      }
    }
    return dist;
  });
}

/** Flood the squares the player reaches from `from` around walls and boxes; returns the lowest square reached. */
function flood(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` completes a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (fixed direction order). */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p] + s;
  return s;
}

/** The square the player ends on after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Push-optimal A* on one board (a room with the other rooms' boxes baked into `wall`, or a whole level):
 * {pushes, moves, expansions}, or null when the expansion budget runs out or no solution exists.
 */
function solvePushes(
  w: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  maxExpansions: number,
): { pushes: number; moves: string; expansions: number } | null {
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = pullDistances(w, wall, goals);
  const nearest = new Int32Array(size).fill(INF);
  for (const dist of dists) for (let i = 0; i < size; i++) if (dist[i]! < nearest[i]!) nearest[i] = dist[i]!;
  const estimate = (boxes: number[]): number => {
    const n = boxes.length;
    if (n > 6) {
      // Too many boxes for the matching below (a whole level searched as one): each box's nearest goal, summed.
      let sum = 0;
      for (const b of boxes) {
        const d = nearest[b]!;
        if (d >= INF) return INF;
        sum += d;
      }
      return sum;
    }
    // Min-cost matching of boxes to goals over pull-distances (DP over goal subsets): every box must end on a
    // distinct goal and needs at least its pull-distance in pushes, so the matched sum never overestimates.
    const dp = new Float64Array(1 << n).fill(INF);
    dp[0] = 0;
    for (let mask = 0; mask < dp.length; mask++) {
      const base = dp[mask]!;
      if (base >= INF) continue;
      let k = 0; // boxes assigned so far = bits set in mask
      for (let m = mask; m; m &= m - 1) k++;
      if (k >= n) continue;
      for (let g = 0; g < n; g++) {
        if (mask & (1 << g)) continue;
        const d = dists[g]![boxes[k]!]!;
        if (d >= INF) continue;
        const nmask = mask | (1 << g);
        if (base + d < dp[nmask]!) dp[nmask] = base + d;
      }
    }
    return dp[dp.length - 1]!;
  };
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (solved(boxes0)) return { pushes: 0, moves: '', expansions: 0 };
  if (estimate(boxes0) >= INF) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes: number[], rep: number): string => boxes.join(',') + '#' + rep;

  // Nodes in creation order: boxes, the player's square, pushes so far, parent, and the push that made the node.
  const nodeBoxes: number[][] = [boxes0];
  const nodePlayer: number[] = [player0];
  const nodeG: number[] = [0];
  const nodeParent: number[] = [-1];
  const nodeFrom: number[] = [-1];
  const nodeTo: number[] = [-1];
  const bestG = new Map<string, number>();
  for (const b of boxes0) occupied[b] = 1;
  bestG.set(keyOf(boxes0, flood(w, wall, occupied, player0, seen, ++stamp, stack)), 0);
  for (const b of boxes0) occupied[b] = 0;

  // Open list: a binary heap on (f, h, creation order), so ties always break the same way.
  const heap: [number, number, number][] = [];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([estimate(boxes0), estimate(boxes0), 0]);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, , s] = heapPop();
    const boxes = nodeBoxes[s]!;
    const g = nodeG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const rep = flood(w, wall, occupied, nodePlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    if (bestG.get(keyOf(boxes, rep)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue; // a cheaper path to this state was already expanded
    }
    if (solved(boxes)) {
      found = s;
      for (const b of boxes) occupied[b] = 0;
      break;
    }
    if (expansions >= maxExpansions) {
      for (const b of boxes) occupied[b] = 0;
      return null;
    }
    expansions++;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || nearest[t]! >= INF) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next: number[] | null = null;
        let key = '';
        let h = INF;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = estimate(next);
          if (h < INF) key = keyOf(next, flood(w, wall, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h >= INF) continue;
        const ng = g + 1;
        const known = bestG.get(key);
        if (known !== undefined && known <= ng) continue;
        bestG.set(key, ng);
        const idx = nodeBoxes.length;
        nodeBoxes.push(next);
        nodePlayer.push(b);
        nodeG.push(ng);
        nodeParent.push(s);
        nodeFrom.push(b);
        nodeTo.push(t);
        heapPush([ng + h, h, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Replay the node chain: walk to each push's stand square, then push.
  occupied.fill(0);
  const chain: number[] = [];
  for (let s = found; s > 0; s = nodeParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0;
  for (const s of chain) {
    const from = nodeFrom[s]!;
    const to = nodeTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nodeBoxes[s]!;
  }
  return { pushes: chain.length, moves, expansions };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway) out of the floor and take the
 * parts left; each part holding boxes is a room. Null when a box or goal sits on a cut square or a part holds
 * unequal boxes and goals — then the level is no set of rooms and is searched whole.
 */
function roomsOf(level: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dists = pullDistances(w, wall, goals);
  const live = new Uint8Array(wall.length);
  for (const dist of dists) for (let i = 0; i < wall.length; i++) if (dist[i]! < INF) live[i] = 1;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b]) || goals.some((g) => cut[g])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const room = { boxes: [] as number[], goals: [] as number[] };
    rooms.push(room);
    part[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          stack.push(q);
        }
      }
    }
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) rooms[part[g]!]!.goals.push(g);
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms
    .filter((r) => r.boxes.length > 0)
    .map((r) => ({ boxes: r.boxes.sort((a, b) => a - b), goals: r.goals.sort((a, b) => a - b) }))
    .sort((a, b) => a.boxes[0]! - b.boxes[0]!);
}

/** Replay `moves` on the level: true when every step is legal and the replay ends with every box on a goal. */
function replaySolves(level: Level, moves: string): boolean {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves.toLowerCase()) {
    const dir = DIRS.find(([, , letter]) => letter === ch);
    if (!dir) return false;
    const d = dir[1] * w + dir[0];
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false;
  return true;
}

/** The moves solving one level, or '' when no solution was found within the work budget. */
function solve(text: string, budget: { left: number }): string {
  const level = parseLevel(text);
  if (level.player < 0 || level.boxes.length !== level.goals.length) return '';
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushes(level.w, level.wall, level.goals, level.boxes, level.player, Math.min(ROOM_EXPANSIONS, budget.left));
    if (whole === null) return '';
    budget.left -= whole.expansions;
    return replaySolves(level, whole.moves) ? whole.moves : '';
  }
  // Room by room, the other rooms' boxes standing as walls; the player walks on from where the last room left it.
  const current = new Map<number, number[]>(); // room index -> its boxes' squares now
  rooms.forEach((room, i) => current.set(i, room.boxes.slice()));
  let player = level.player;
  let moves = '';
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i]!;
    const wall = level.wall.slice();
    rooms.forEach((_, j) => {
      if (j !== i) for (const b of current.get(j)!) wall[b] = 1;
    });
    const cap = Math.min(ROOM_EXPANSIONS, budget.left);
    if (cap <= 0) return '';
    const solvedRoom = solvePushes(level.w, wall, room.goals, current.get(i)!, player, cap);
    if (solvedRoom === null) return '';
    budget.left -= solvedRoom.expansions;
    moves += solvedRoom.moves;
    player = endOf(level.w, player, solvedRoom.moves);
    current.set(i, room.goals.slice());
  }
  return replaySolves(level, moves) ? moves : '';
}

const budget = { left: SET_EXPANSIONS };
for (const id of readdirSync(IN_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  if (moves.length > 65_000) moves = '';
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
