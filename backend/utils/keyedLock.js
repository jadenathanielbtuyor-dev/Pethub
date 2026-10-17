// Runs tasks that share a key one after another inside this Node.js process, so a check followed by a write
// (is the slot still free? -> approve) cannot interleave with another request doing the same.
// It does not reach across processes: with more than one backend instance, the same rule needs a database lock.
const tails = new Map();

async function runExclusive(key, task) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  // Every link in the chain resolves (never rejects), so one failing task never blocks the next
  const tail = previous.then(() => current);
  tails.set(key, tail);

  try {
    await previous;
    return await task();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function pendingKeyCount() {
  return tails.size;
}

module.exports = {
  runExclusive,
  pendingKeyCount
};
