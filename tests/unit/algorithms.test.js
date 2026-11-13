const { optimalPlacement, solveTimetable } = require('../../modules/algorithms/placement');

describe('optimalPlacement', () => {
  it('places every student when there is enough capacity', () => {
    const students = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, group: 1 }));
    const rooms = [{ number: 'A', rows: 5, cols: 5 }];
    const { placement, unplaced } = optimalPlacement(students, rooms);
    expect(unplaced).toBe(0);
    expect(placement).toHaveLength(25);
    expect(new Set(placement.map((p) => p.studentId)).size).toBe(25);
  });

  it('splits students across rooms by capacity', () => {
    const students = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, group: 1 }));
    const rooms = [
      { number: 'A', rows: 2, cols: 5 },
      { number: 'B', rows: 2, cols: 5 },
      { number: 'C', rows: 2, cols: 5 }
    ];
    const { placement, unplaced } = optimalPlacement(students, rooms);
    expect(unplaced).toBe(0);
    const byRoom = placement.reduce((acc, p) => {
      acc[p.roomNumber] = (acc[p.roomNumber] || 0) + 1;
      return acc;
    }, {});
    expect(byRoom).toEqual({ A: 10, B: 10, C: 10 });
  });

  it('reports students that do not fit', () => {
    const students = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, group: 1 }));
    const rooms = [{ number: 'A', rows: 2, cols: 2 }];
    const { placement, unplaced } = optimalPlacement(students, rooms);
    expect(placement).toHaveLength(4);
    expect(unplaced).toBe(1);
  });

  it('avoids same-group neighbours for two mixed exam groups', () => {
    const students = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `A${i}`, group: 'A' })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: `B${i}`, group: 'B' }))
    ];
    const rooms = [{ number: 'Hall', rows: 4, cols: 4 }];
    const { placement, unplaced } = optimalPlacement(students, rooms);
    expect(unplaced).toBe(0);
    const grid = Array.from({ length: 4 }, () => Array(4).fill(null));
    placement.forEach((p) => { grid[p.row][p.col] = p.studentId[0]; });
    const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    let conflicts = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        for (const [dr, dc] of neighbours) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= 4 || nc >= 4) continue;
          if (grid[r][c] && grid[nr][nc] && grid[r][c] === grid[nr][nc]) conflicts += 1;
        }
      }
    }
    expect(conflicts).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const students = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, group: i % 3 }));
    const rooms = [{ number: 'A', rows: 3, cols: 4 }];
    const first = optimalPlacement(students, rooms);
    const second = optimalPlacement(students, rooms);
    expect(first).toEqual(second);
  });
});

describe('solveTimetable', () => {
  it('uses one slot when exams do not conflict', () => {
    const exams = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { slots, color } = solveTimetable(exams, {});
    expect(slots).toBe(1);
    expect(new Set(Object.values(color)).size).toBe(1);
  });

  it('separates two conflicting exams into two slots', () => {
    const exams = [{ id: 1 }, { id: 2 }];
    const conflicts = { 1: new Set([2]), 2: new Set([1]) };
    const { slots, color } = solveTimetable(exams, conflicts);
    expect(slots).toBe(2);
    expect(color[1]).not.toBe(color[2]);
  });

  it('uses three slots for a triangle of conflicts', () => {
    const exams = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const conflicts = {
      1: new Set([2, 3]),
      2: new Set([1, 3]),
      3: new Set([1, 2])
    };
    const { slots } = solveTimetable(exams, conflicts);
    expect(slots).toBe(3);
  });

  it('never gives conflicting exams the same slot', () => {
    const exams = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const conflicts = {};
    exams.forEach((e) => { conflicts[e.id] = new Set(); });
    // Dense conflict graph: each exam conflicts with the next three.
    exams.forEach((e, i) => {
      for (let k = 1; k <= 3; k++) {
        const other = exams[(i + k) % exams.length];
        if (other.id !== e.id) {
          conflicts[e.id].add(other.id);
          conflicts[other.id].add(e.id);
        }
      }
    });
    const { color } = solveTimetable(exams, conflicts);
    for (const e of exams) {
      for (const other of conflicts[e.id]) {
        expect(color[e.id]).not.toBe(color[other]);
      }
    }
  });
});
