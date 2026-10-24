export class DesktopTabCloseCoordinator {
  #inFlight = new Map();
  #operations;

  constructor(operations) {
    this.#operations = operations;
  }

  close(targetId) {
    const existing = this.#inFlight.get(targetId);
    const selected = this.#operations.getTab(targetId);
    this.#operations.assertAllowed(selected?.taskId || existing?.taskId);
    if (existing) return existing.promise;
    if (!selected) return Promise.resolve(false);
    const operation = this.#closeSelected(selected).finally(() => {
      if (this.#inFlight.get(targetId)?.promise === operation) this.#inFlight.delete(targetId);
    });
    this.#inFlight.set(targetId, { promise: operation, taskId: selected.taskId });
    return operation;
  }

  async #closeSelected(selected) {
    await this.#operations.closeHost(selected);
    if (this.#operations.getTab(selected.targetId) !== selected) return false;

    this.#operations.finalizeClosed(selected);
    let activationError;
    const replacement = selected.active ? this.#operations.findReplacement(selected.taskId) : undefined;
    if (replacement) {
      try {
        await this.#operations.activate(replacement.targetId);
      } catch (error) {
        activationError = error;
      }
    }

    let persistenceError;
    try {
      this.#operations.persist();
    } catch (error) {
      persistenceError = error;
    }
    if (activationError && persistenceError) {
      throw new AggregateError([activationError, persistenceError], "Tab closed, but fallback activation and persistence failed");
    }
    if (persistenceError) throw persistenceError;
    if (activationError) throw activationError;
    return true;
  }
}
