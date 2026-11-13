// Pure placement and scheduling algorithms. No database or framework imports,
// so they can be unit-tested directly and reused by any module.

// Adjacent seats share an edge. Diagonal separation is a stronger constraint
// that is infeasible for two large groups on a rectangular grid.
const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/**
 * Seat students across rooms while avoiding same-group neighbours (edge-adjacent).
 * Greedy cell-first: at each seat pick the group with the fewest same-group
 * neighbours, tie-breaking toward the group with the most students left.
 *
 * @param {{id: number|string, group: number|string}[]} students
 * @param {{number: string, rows: number, cols: number}[]} rooms
 * @returns {{placement: {studentId: any, roomNumber: string, row: number, col: number}[], unplaced: number}}
 */
function optimalPlacement(students, rooms) {
  const groups = {};
  students.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s.id); });
  const groupKeys = Object.keys(groups);
  const state = rooms.map((r) => ({
    number: r.number, rows: r.rows, cols: r.cols,
    grid: Array.from({ length: r.rows }, () => Array(r.cols).fill(null)),
    capacity: r.rows * r.cols
  }));
  const placement = [];
  let remaining = students.length;

  for (const room of state) {
    for (let r = 0; r < room.rows && remaining > 0; r++) {
      for (let c = 0; c < room.cols && remaining > 0; c++) {
        // At each seat choose the group with the fewest same-group neighbours;
        // ties go to the group with the most students left, which naturally
        // produces a checkerboard interleave for two mixed exams.
        let bestGroup = null;
        let bestScore = Infinity;
        let bestRemaining = -1;
        for (const g of groupKeys) {
          if (!groups[g].length) continue;
          let score = 0;
          for (const [dr, dc] of NEIGHBOURS) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= room.rows || nc >= room.cols) continue;
            const v = room.grid[nr][nc];
            if (v && v.group === g) score += 1;
          }
          const rem = groups[g].length;
          if (score < bestScore || (score === bestScore && rem > bestRemaining)) {
            bestScore = score;
            bestGroup = g;
            bestRemaining = rem;
          }
        }
        if (!bestGroup) break;
        const sid = groups[bestGroup].shift();
        room.grid[r][c] = { studentId: sid, group: bestGroup };
        placement.push({ studentId: sid, roomNumber: room.number, row: r, col: c });
        remaining -= 1;
      }
    }
  }

  return { placement, unplaced: remaining };
}

/**
 * Greedy graph colouring: assign the fewest slots so that conflicting exams
 * (exams sharing a student) never receive the same slot.
 *
 * @param {{id: number|string}[]} exams
 * @param {Record<string|number, Set<string|number>|(string|number)[]>} conflicts
 * @returns {{color: Record<string, number>, slots: number}}
 */
function solveTimetable(exams, conflicts) {
  const adj = {};
  exams.forEach((e) => { adj[e.id] = new Set(conflicts[e.id] || []); });
  const order = exams.map((e) => e.id).sort((a, b) => adj[b].size - adj[a].size);
  const color = {};
  let maxColor = 0;
  for (const id of order) {
    const used = new Set();
    for (const nb of adj[id]) if (color[nb] !== undefined) used.add(color[nb]);
    let c = 0;
    while (used.has(c)) c += 1;
    color[id] = c;
    if (c + 1 > maxColor) maxColor = c + 1;
  }
  return { color, slots: maxColor };
}

module.exports = { NEIGHBOURS, optimalPlacement, solveTimetable };
