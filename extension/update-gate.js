// An update can arrive while a command is awaiting Chrome or while a response
// is queued for reconnect. Recheck after work drains, including work that
// started and finished while the asynchronous outbox check was in progress.
export function createUpdateGate({ hasPendingWork, reload, reportError }) {
  let version;
  let active = 0;
  let revision = 0;
  let checking = false;

  async function check() {
    if (!version || active || checking) return;
    checking = true;
    const checkedRevision = revision;
    try {
      const pending = await hasPendingWork();
      if (!pending && !active && checkedRevision === revision) {
        const ready = version;
        version = undefined;
        reload(ready);
      }
    } catch (error) {
      reportError(error);
    } finally {
      checking = false;
      if (checkedRevision !== revision) void check();
    }
  }

  return {
    available(nextVersion) {
      version = nextVersion;
      return check();
    },
    check,
    async run(work) {
      active++;
      revision++;
      try {
        return await work();
      } finally {
        active--;
        void check();
      }
    },
  };
}
