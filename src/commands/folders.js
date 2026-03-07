import { graphGet } from '../graph.js';
import { formatFolderRow } from '../format.js';

export async function folders() {
  const result = await graphGet('/me/mailFolders?$top=50');
  result.value.forEach(f => console.log(formatFolderRow(f)));
}
