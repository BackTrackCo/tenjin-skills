// The gate files (apply, batch, net) still import the graph from here: the gates hash covers their bytes, so their import line moves with
// the step that rewrites each of them. Every other module imports the base loader directly.
export { graph } from '../../../loop-base/lib/graph.mjs';
