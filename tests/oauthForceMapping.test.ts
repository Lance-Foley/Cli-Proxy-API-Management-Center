import { describe, expect, test } from 'bun:test';
import {
  normalizeOauthModelAlias,
  serializeOauthModelAliases,
} from '../src/services/api/authFiles';

describe('OAuth model alias force mapping', () => {
  test('normalizes and serializes force-mapping without dropping it', () => {
    const normalized = normalizeOauthModelAlias({
      codex: [
        { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
        { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
      ],
    });

    expect(normalized.codex).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', forceMapping: true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', forceMapping: false },
    ]);
    expect(serializeOauthModelAliases(normalized.codex)).toEqual([
      { name: 'gpt-source', alias: 'gpt-alias', 'force-mapping': true },
      { name: 'gpt-source-2', alias: 'gpt-alias-2', 'force-mapping': false },
    ]);
  });

  test('preserves backend display-name when a channel is rewritten', () => {
    const normalized = normalizeOauthModelAlias({
      claude: [
        { name: 'claude-source', alias: 'claude-alias', fork: true, 'display-name': ' Shown ' },
        { name: 'claude-plain', alias: 'claude-plain-alias', 'display-name': '' },
      ],
    });

    expect(normalized.claude).toEqual([
      { name: 'claude-source', alias: 'claude-alias', fork: true, displayName: 'Shown' },
      { name: 'claude-plain', alias: 'claude-plain-alias' },
    ]);
    expect(serializeOauthModelAliases(normalized.claude)).toEqual([
      { name: 'claude-source', alias: 'claude-alias', fork: true, 'display-name': 'Shown' },
      { name: 'claude-plain', alias: 'claude-plain-alias' },
    ]);
  });
});
