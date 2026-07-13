import { sort } from '../sorter/sort.js';

export async function sortCommand(options) {
  await sort({
    dryRun: options.dryRun || false,
    since: options.since || null,
    limit: options.limit ? parseInt(options.limit) : null,
    minAge: options.minAge !== undefined ? parseFloat(options.minAge) : undefined
  });
}
