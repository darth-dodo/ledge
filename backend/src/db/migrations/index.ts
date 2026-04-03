import { InitialSchema1709700000000 } from './1709700000000-InitialSchema';
import { AddChatTables1709700000001 } from './1709700000001-AddChatTables';
import { ChangeEmbeddingDimension1709700000002 } from './1709700000002-ChangeEmbeddingDimension';

export const migrations = [
  InitialSchema1709700000000,
  AddChatTables1709700000001,
  ChangeEmbeddingDimension1709700000002,
];
