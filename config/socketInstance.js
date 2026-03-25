let _io = null;

module.exports = {
  init: (io) => { _io = io; },
  get: () => _io,
  /** Emit to a specific employee's socket room */
  emitTo: (employeeId, event, data) => {
    if (_io && employeeId) _io.to(String(employeeId)).emit(event, data);
  },
  /** Emit to multiple employees */
  emitToMany: (employeeIds, event, data) => {
    if (!_io) return;
    (employeeIds || []).forEach((id) => _io.to(String(id)).emit(event, data));
  },
};
