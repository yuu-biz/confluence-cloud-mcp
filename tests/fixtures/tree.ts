/**
 * Synthetic mid-size space: many top-level branches, a few of them deep. Mirrors the shape that
 * made a single content-tree call unusable before compact rendering, without any real names.
 */
export interface DescendantFixture {
  id: string;
  title: string;
  type: string;
  status: string;
  parentId: string;
  depth: number;
  childPosition: number;
}

const BRANCH_NAMES = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
];

export const FIXTURE_ROOT_ID = 'root-0';
export const FIXTURE_BRANCH_COUNT = BRANCH_NAMES.length;
/** Branches that also carry grandchildren and great-grandchildren. */
export const DEEP_BRANCH_INDEXES = [0, 3, 7];

export function midSizeTreeDescendants(): DescendantFixture[] {
  const items: DescendantFixture[] = [];
  const push = (
    id: string,
    title: string,
    parentId: string,
    depth: number,
    childPosition: number,
    type = 'page',
  ): void => {
    items.push({ id, title, type, status: 'current', parentId, depth, childPosition });
  };

  BRANCH_NAMES.forEach((name, branchIndex) => {
    const branchId = `b${branchIndex}`;
    push(branchId, `Branch ${name}`, FIXTURE_ROOT_ID, 1, branchIndex, 'folder');
    const childCount = 4;
    for (let child = 0; child < childCount; child += 1) {
      const childId = `${branchId}-c${child}`;
      push(childId, `${name} Page ${child + 1}`, branchId, 2, child);
      if (!DEEP_BRANCH_INDEXES.includes(branchIndex)) continue;
      for (let grandchild = 0; grandchild < 3; grandchild += 1) {
        const grandchildId = `${childId}-g${grandchild}`;
        push(grandchildId, `${name} Detail ${child + 1}.${grandchild + 1}`, childId, 3, grandchild);
        if (grandchild !== 0) continue;
        push(
          `${grandchildId}-l0`,
          `${name} Note ${child + 1}.${grandchild + 1}.1`,
          grandchildId,
          4,
          0,
        );
      }
    }
  });
  return items;
}

export function descendantsWithinDepth(depth: number): DescendantFixture[] {
  return midSizeTreeDescendants().filter((item) => item.depth <= depth);
}
