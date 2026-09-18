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

export const VERSION_CONTAINER_ID = 'b0-c0-versions';
/** Version pages held under one container, each with its own section pages. */
export const VERSION_HISTORY_ITEMS = 12 * 4;

/**
 * The same space with retained document versions attached to the first branch, the shape that
 * pushed real sibling branches out of a single descendants read.
 */
export function treeWithVersionHistory(): DescendantFixture[] {
  const items = midSizeTreeDescendants();
  const anchor = items.findIndex((item) => item.id === 'b0-c0');
  const history: DescendantFixture[] = [
    {
      id: VERSION_CONTAINER_ID,
      title: 'Versions of Alpha Page 1',
      type: 'folder',
      status: 'current',
      parentId: 'b0-c0',
      depth: 3,
      childPosition: 99,
    },
  ];
  for (let version = 0; version < 12; version += 1) {
    const versionId = `${VERSION_CONTAINER_ID}-v${version}`;
    history.push({
      id: versionId,
      title: `Alpha Page 1 v${version + 1}`,
      type: 'page',
      status: 'current',
      parentId: VERSION_CONTAINER_ID,
      depth: 4,
      childPosition: version,
    });
    for (let section = 0; section < 3; section += 1) {
      history.push({
        id: `${versionId}-s${section}`,
        title: `Alpha Page 1 v${version + 1} Section ${section + 1}`,
        type: 'page',
        status: 'current',
        parentId: versionId,
        depth: 5,
        childPosition: section,
      });
    }
  }
  // Inserted where Confluence would return it: inside the first branch, before later branches.
  items.splice(anchor + 1, 0, ...history);
  return items;
}
