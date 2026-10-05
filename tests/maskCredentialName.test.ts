import { describe, expect, test } from 'bun:test';
import { maskCredentialName } from '@/utils/quota/maskName';

describe('maskCredentialName', () => {
  test('masks the mailbox and domain but keeps provider prefix and file extension', () => {
    expect(maskCredentialName('claude-theo@1xyz.dev.json')).toBe('claude-t•••@1•••.dev.json');
  });

  test('keeps the id prefix and plan suffix on codex files', () => {
    expect(maskCredentialName('codex-ae5d455f-theo@gmail.com-pro.json')).toBe(
      'codex-ae5d455f-t•••@g•••.com-pro.json'
    );
  });

  test('leaves names without an email untouched', () => {
    expect(maskCredentialName('kimi-main.json')).toBe('kimi-main.json');
    expect(maskCredentialName('')).toBe('');
  });

  test('never leaks the full local part', () => {
    expect(maskCredentialName('claude-someone.secret@mail.example.org.json')).not.toContain(
      'secret'
    );
  });
});
