/**
 * Guards the modules barrel line. Imports only the real barrel: if
 * `import './slack-ui/index.js';` is missing from src/modules/index.ts, or the
 * barrel cannot load, the post_card delivery action is never registered.
 */
import { describe, expect, it } from 'vitest';

import '../index.js';
import { getDeliveryAction } from '../../delivery.js';

describe('slack-ui registration', () => {
  it('the modules barrel registers the post_card delivery action', () => {
    expect(getDeliveryAction('post_card')).toBeDefined();
  });
});
