/**
 * Every project that loads @matrix-org/matrix-sdk-crypto-wasm, directly or through a package
 * such as matrix-js-sdk, really loads libs/native/crypto-backend (a pnpm override). Nx sees only
 * the external package, so without a dependency path to the facade an edit to it would leave
 * those projects out of `nx affected` and replay their cached builds and tests. The implicit
 * dependencies sit on the few projects every other one reaches (util-matrix first).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FACADE = 'native-crypto-backend';
const WASM = 'npm:@matrix-org/matrix-sdk-crypto-wasm';

/** Projects with an edge to an external node that is, or depends on, `target`. */
export const externalDependents = (
  { nodes, externalNodes, dependencies },
  target,
) => {
  const reaching = new Set([target]);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of Object.keys(externalNodes)) {
      if (
        !reaching.has(name) &&
        (dependencies[name] ?? []).some((edge) => reaching.has(edge.target))
      ) {
        reaching.add(name);
        grew = true;
      }
    }
  }
  return Object.keys(nodes)
    .filter((project) =>
      (dependencies[project] ?? []).some((edge) => reaching.has(edge.target)),
    )
    .sort();
};

describe('crypto backend facade dependents', () => {
  it('finds projects that reach the package through another package', () => {
    const graph = {
      nodes: { a: {}, b: {}, c: {} },
      externalNodes: { [WASM]: {}, 'npm:sdk': {}, 'npm:other': {} },
      dependencies: {
        a: [{ target: WASM }],
        b: [{ target: 'npm:sdk' }],
        c: [{ target: 'npm:other' }],
        'npm:sdk': [{ target: WASM }],
      },
    };
    expect(externalDependents(graph, WASM)).toEqual(['a', 'b']);
  });

  it('makes every project that loads the WASM package depend on the facade', async () => {
    // nx's devkit entry point is not in its package exports; the graph needs its external nodes.
    const { createProjectGraphAsync } = await import(
      pathToFileURL(
        join(
          import.meta.dirname,
          '../node_modules/nx/dist/src/devkit-exports.js',
        ),
      ).href
    );
    const graph = await createProjectGraphAsync({ exitOnError: false });
    const dependents = externalDependents(graph, WASM).filter(
      (project) => project !== FACADE,
    );
    expect(dependents).toContain('util-matrix');
    expect(dependents).toContain('data-access-auth');
    const reachesFacade = (project, seen = new Set()) =>
      project === FACADE ||
      (!seen.has(project) &&
        seen.add(project) &&
        graph.dependencies[project].some(
          (edge) =>
            graph.nodes[edge.target] && reachesFacade(edge.target, seen),
        ));
    expect(
      dependents.filter((project) => !reachesFacade(project)),
      'add "implicitDependencies": ["native-crypto-backend"]',
    ).toEqual([]);
  });
});
