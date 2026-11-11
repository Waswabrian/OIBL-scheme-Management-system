const assert = require('assert');
const { getMailConfig, sendAppEmail } = require('../utils/emailNotifications');

const config = getMailConfig();
assert.ok(config !== null, 'Mail configuration should be available in the runtime environment');

(async () => {
  const result = await sendAppEmail({
    to: 'test@example.com',
    subject: 'Test notification',
    text: 'This is a test message.'
  });

  assert.ok(result !== null, 'sendAppEmail should return a result object');
  console.log('email notification test passed');
})();
