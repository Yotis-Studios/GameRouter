const crypto = require('crypto');
const md5 = require('md5');

module.exports = {
  // A small challenge space (e.g. random.int(1, 999999)) is precomputable
  // offline into a full challenge->solution lookup table by anyone who
  // knows the access key, which turns the "proof of work" into an O(1)
  // lookup instead of real per-request work. 128 bits of entropy makes
  // precomputing every possible challenge infeasible.
  generateChallenge: () => crypto.randomBytes(16).toString('hex'),
  testSolution: (constant, challenge, solution) => {
    if (!challenge || !solution) return false;
    const digest = constant + challenge + solution;
    const hash = md5(digest);
    return hash[0] === '0' && hash[1] === '0' && hash[2] === '0';
  }
};
