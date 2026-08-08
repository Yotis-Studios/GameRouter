const md5 = require('md5');
const random = require('random');

module.exports = {
  generateChallenge: () => {
    const randInt = random.int(1, 999999);
    return randInt.toString();
  },
  testSolution: (constant, challenge, solution) => {
    if (!challenge || !solution) return false;
    const digest = constant + challenge + solution;
    const hash = md5(digest);
    return hash[0] === '0' && hash[1] === '0' && hash[2] === '0';
  }
};
