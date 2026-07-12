import { sort } from '../sorter/sort.js';

export async function sortCommand(options) {
  await sort({
    verbose: true,
    dryRun: options.dryRun || false,
    all: options.all || false,
    since: options.since || null,
    limit: parseInt(options.limit) || 100
  });
}
