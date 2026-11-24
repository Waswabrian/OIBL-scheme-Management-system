const assert = require('assert');
const { getMailConfig, sendAppEmail } = require('../utils/emailNotifications');

const config = getMailConfig();

(async () => {
  const result = await sendAppEmail({
    to: 'test@example.com',
    subject: 'Test notification',
    text: 'This is a test message.'
  });

  assert.ok(result !== null, 'sendAppEmail should return a result object');
  console.log('email notification test passed');
})();
