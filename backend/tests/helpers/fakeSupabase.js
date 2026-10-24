// In-memory stand-in for the parts of supabase-js (PostgREST) that PetHub's repositories use. Tests only.
// It mirrors the behaviour the code depends on: column checks (42703 / PGRST204), uuid checks (22P02),
// unique indexes (23505), conditional updates that return 0 rows, and returning-select after insert/update.
// db.log records every query (table + action), so tests can check which tables a request touched.
const crypto = require('crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameValue(stored, expected) {
  if (stored === null || stored === undefined) return expected === null || expected === undefined;
  if (typeof stored === 'boolean') return stored === (expected === true || expected === 'true');
  return String(stored) === String(expected);
}

function toComparable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function compare(stored, expected) {
  const left = toComparable(stored);
  const right = toComparable(expected);
  if (left === null || right === null) return null;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// LIKE is case-sensitive and ILIKE is not, as in PostgreSQL
function likeToRegExp(pattern, { caseSensitive = false } = {}) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, caseSensitive ? '' : 'i');
}

class FakeQuery {
  constructor(database, tableName) {
    this.database = database;
    this.tableName = tableName;
    this.action = 'select';
    this.columns = '*';
    this.returning = false;
    this.countMode = null;
    this.head = false;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.offsetCount = 0;
    this.singleMode = null;
    this.payload = null;
  }

  select(columns = '*', options = {}) {
    if (this.action === 'select') {
      this.columns = columns;
      this.countMode = options.count || null;
      this.head = Boolean(options.head);
    } else {
      this.returning = true;
      this.columns = columns;
    }
    return this;
  }

  insert(rows) {
    this.action = 'insert';
    this.payload = (Array.isArray(rows) ? rows : [rows]).map(row => ({ ...row }));
    return this;
  }

  // onConflict: the unique column that decides between updating an existing row and inserting a new one
  upsert(rows, { onConflict } = {}) {
    this.action = 'upsert';
    this.onConflict = onConflict;
    this.payload = (Array.isArray(rows) ? rows : [rows]).map(row => ({ ...row }));
    return this;
  }

  update(values) {
    this.action = 'update';
    this.payload = { ...values };
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  addFilter(column, values, test) {
    this.filters.push({ column, values, test });
    return this;
  }

  eq(column, value) { return this.addFilter(column, [value], stored => sameValue(stored, value)); }
  neq(column, value) { return this.addFilter(column, [value], stored => !sameValue(stored, value)); }
  in(column, values) { return this.addFilter(column, values, stored => values.some(value => sameValue(stored, value))); }
  is(column, value) { return this.addFilter(column, [], stored => (value === null ? stored === null || stored === undefined : stored === value)); }
  lt(column, value) { return this.addFilter(column, [], stored => compare(stored, value) === -1); }
  lte(column, value) { return this.addFilter(column, [], stored => [-1, 0].includes(compare(stored, value))); }
  gt(column, value) { return this.addFilter(column, [], stored => compare(stored, value) === 1); }
  gte(column, value) { return this.addFilter(column, [], stored => [1, 0].includes(compare(stored, value))); }
  ilike(column, pattern) { return this.addFilter(column, [], stored => likeToRegExp(pattern).test(String(stored ?? ''))); }

  not(column, operator, value) {
    if (operator === 'is') {
      return this.addFilter(column, [], stored => !(value === null ? stored === null || stored === undefined : stored === value));
    }
    if (operator === 'like') {
      // NOT (NULL LIKE ...) is NULL in SQL, so rows without a value never match
      return this.addFilter(column, [], stored => stored !== null && stored !== undefined &&
        !likeToRegExp(value, { caseSensitive: true }).test(String(stored)));
    }
    throw new Error(`Fake Supabase: not(${operator}) is not supported`);
  }

  // PostgreSQL puts NULLs last when ascending and first when descending, unless nullsFirst says otherwise
  order(column, { ascending = true, nullsFirst = !ascending } = {}) {
    this.orders.push({ column, ascending, nullsFirst });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  // PostgREST range: rows from..to inclusive (0-based), after filters and ordering
  range(from, to) {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  // PostgREST or(): "col.op.value,col.op.value" with op eq, ilike or is (null); a row matches when any part matches
  or(expression) {
    const parts = String(expression).split(',').map(part => {
      const [column, operator, ...rest] = part.split('.');
      const value = rest.join('.');
      if (operator === 'eq') return stored => sameValue(stored[column], value);
      if (operator === 'ilike') return stored => likeToRegExp(value.replace(/\*/g, '%')).test(String(stored[column] ?? ''));
      if (operator === 'is' && value === 'null') return stored => stored[column] === null || stored[column] === undefined;
      throw new Error(`Fake Supabase: or(${operator}) is not supported`);
    });
    this.filters.push({ column: null, values: [], test: null, rowTest: row => parts.some(test => test(row)) });
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybe';
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  then(onFulfilled, onRejected) {
    return this.execute().then(onFulfilled, onRejected);
  }

  async execute() {
    // Let other requests interleave, like a real network round trip
    await new Promise(resolve => setImmediate(resolve));
    return this.database.run(this);
  }
}

class FakeDatabase {
  constructor(definitions) {
    this.definitions = definitions;
    this.rows = {};
    this.interceptors = [];
    this.log = [];
    Object.keys(definitions).forEach(name => { this.rows[name] = []; });
  }

  client() {
    return {
      from: tableName => new FakeQuery(this, tableName),
      rpc: (functionName, args) => this.runRpc(functionName, args)
    };
  }

  table(name) {
    return this.rows[name];
  }

  find(name, predicate) {
    return this.rows[name].find(predicate);
  }

  // Runs handler(query, database) before the next matching query; returning a result short-circuits the query
  interceptNext({ table, action }, handler) {
    this.interceptors.push({ table, action, handler });
  }

  failNext({ table, action }, error) {
    this.interceptNext({ table, action }, () => ({ data: null, error }));
  }

  seed(name, row) {
    const definition = this.definitions[name];
    const stored = this.applyDefaults(definition, { ...row });
    this.rows[name].push(stored);
    return stored;
  }

  applyDefaults(definition, row) {
    Object.entries(definition.defaults || {}).forEach(([column, makeDefault]) => {
      if (row[column] === undefined) row[column] = makeDefault();
    });
    return row;
  }

  error(code, message) {
    return { data: null, error: { code, message, details: null, hint: null } };
  }

  async runRpc(functionName, args = {}) {
    this.log.push({ table: 'appointments', action: 'rpc', functionName });
    const interceptionIndex = this.interceptors.findIndex(entry => entry.table === 'appointments' && entry.action === 'rpc');
    if (interceptionIndex >= 0) {
      const [interception] = this.interceptors.splice(interceptionIndex, 1);
      const outcome = await interception.handler({ functionName, payload: args, action: 'rpc' }, this);
      if (outcome) return outcome;
    }
    if (functionName === 'create_appointment_if_available') {
      const existing = this.rows.appointments.find(row => (
        String(row.user_id) === String(args.p_user_id)
        && String(row.pet_id) === String(args.p_pet_id)
        && String(row.service_type) === String(args.p_service_type)
        && String(row.appointment_date).slice(0, 10) === String(args.p_appointment_date).slice(0, 10)
        && String(row.appointment_time).slice(0, 5) === String(args.p_appointment_time).slice(0, 5)
        && String(row.status) === 'Pending'
      ));
      if (existing) return { data: { outcome: 'existing', appointment_id: existing.id }, error: null, status: 200 };

      const clockMinutes = value => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
        return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
      };
      const start = clockMinutes(args.p_appointment_time);
      const end = start + Number(args.p_estimated_duration_minutes);
      const conflict = this.rows.appointments.some(row => {
        if (String(row.appointment_date).slice(0, 10) !== String(args.p_appointment_date).slice(0, 10)) return false;
        if (!['Pending', 'Approved', 'Completed'].includes(String(row.status))) return false;
        const duration = Number(row.estimated_duration_minutes);
        const existingStart = clockMinutes(row.appointment_time);
        if (!Number.isInteger(duration) || duration < 5 || duration > 480 || !Number.isFinite(existingStart)) return false;
        return start < existingStart + duration && existingStart < end;
      });
      if (conflict) return { data: { outcome: 'conflict' }, error: null, status: 200 };

      const appointment = this.seed('appointments', {
        user_id: args.p_user_id,
        pet_id: args.p_pet_id,
        pet_name: args.p_pet_name,
        service_type: args.p_service_type,
        estimated_duration_minutes: args.p_estimated_duration_minutes,
        appointment_date: args.p_appointment_date,
        appointment_time: args.p_appointment_time,
        status: 'Pending'
      });
      return { data: { outcome: 'created', appointment_id: appointment.id }, error: null, status: 200 };
    }
    if (functionName === 'update_appointment_status_if_available') {
      const appointment = this.rows.appointments.find(row => String(row.id) === String(args.p_appointment_id));
      if (!appointment) return { data: { outcome: 'not_found' }, error: null, status: 200 };
      if (String(appointment.status) !== String(args.p_expected_status)) {
        return { data: { outcome: 'stale' }, error: null, status: 200 };
      }
      if (args.p_status === 'Approved') {
        const clockMinutes = value => {
          const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
          return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
        };
        const start = clockMinutes(appointment.appointment_time);
        const duration = Number(appointment.estimated_duration_minutes);
        const conflict = this.rows.appointments.some(row => {
          if (String(row.id) === String(appointment.id)) return false;
          if (String(row.appointment_date).slice(0, 10) !== String(appointment.appointment_date).slice(0, 10)) return false;
          if (!['Approved', 'Completed'].includes(String(row.status))) return false;
          const otherStart = clockMinutes(row.appointment_time);
          const otherDuration = Number(row.estimated_duration_minutes);
          if (!Number.isFinite(start) || !Number.isFinite(otherStart) || duration < 5 || otherDuration < 5) return false;
          return start < otherStart + otherDuration && otherStart < start + duration;
        });
        if (conflict) return { data: { outcome: 'conflict' }, error: null, status: 200 };
      }
      appointment.status = args.p_status;
      appointment.handled_by = args.p_handled_by;
      if (args.p_status === 'Cancelled') {
        appointment.cancelled_at = new Date().toISOString();
        appointment.cancelled_by = args.p_handled_by;
      }
      return { data: { outcome: 'updated', appointment_id: appointment.id }, error: null, status: 200 };
    }
    // database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql, same outcomes as the SQL functions
    const minutesOf = value => {
      const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
      return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
    };
    const clock = total => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
    const overlapsActive = (date, start, end, excludedId = null) => this.rows.appointments.some(row => {
      if (excludedId && String(row.id) === String(excludedId)) return false;
      if (String(row.appointment_date).slice(0, 10) !== String(date).slice(0, 10)) return false;
      if (!['Pending', 'Approved', 'Completed'].includes(String(row.status))) return false;
      const duration = Number(row.estimated_duration_minutes);
      const otherStart = minutesOf(row.appointment_time);
      if (!Number.isInteger(duration) || duration < 5 || duration > 480 || !Number.isFinite(otherStart)) return false;
      return start < otherStart + duration && otherStart < end;
    });
    if (functionName === 'create_appointment_group_if_available') {
      const items = Array.isArray(args.p_items) ? args.p_items : [];
      if (!args.p_user_id || !args.p_appointment_date || !args.p_start_time || !/^[0-9a-f]{64}$/.test(String(args.p_request_key || ''))
          || items.length < 2 || items.length > 6 || new Set(items.map(item => String(item.pet_id))).size !== items.length
          || items.some(item => !Number.isInteger(Number(item.duration_minutes)) || item.duration_minutes < 5 || item.duration_minutes > 480)) {
        return this.error('22023', 'Invalid booking request');
      }
      let total = 0;
      for (const [index, item] of items.entries()) {
        const service = this.rows.pethub_service_catalog.find(row => String(row.id) === String(item.service_id));
        if (!service || service.online_booking_enabled !== true || service.duration_minutes !== Number(item.duration_minutes) || service.name !== item.service_type) {
          return { data: { outcome: 'service_changed', position: index + 1 }, error: null, status: 200 };
        }
        const pet = this.rows.pets.find(row => String(row.id) === String(item.pet_id) && String(row.user_id) === String(args.p_user_id));
        if (!pet) return { data: { outcome: 'pet_not_found', position: index + 1 }, error: null, status: 200 };
        if (!(service.species || []).includes(pet.species)) return { data: { outcome: 'species_not_offered', position: index + 1 }, error: null, status: 200 };
        total += service.duration_minutes;
      }
      const start = minutesOf(args.p_start_time);
      if (start + total > 24 * 60) return { data: { outcome: 'past_end_of_day' }, error: null, status: 200 };
      const existing = this.rows.appointment_groups.find(group => String(group.user_id) === String(args.p_user_id)
        && group.request_key === args.p_request_key
        && !this.rows.appointments.some(row => String(row.group_id) === String(group.id) && row.status !== 'Pending'));
      if (existing) return { data: { outcome: 'existing', group_id: existing.id }, error: null, status: 200 };
      let slot = start;
      for (const [index, item] of items.entries()) {
        if (overlapsActive(args.p_appointment_date, slot, slot + Number(item.duration_minutes))) {
          return { data: { outcome: 'conflict', position: index + 1 }, error: null, status: 200 };
        }
        slot += Number(item.duration_minutes);
      }
      const group = this.seed('appointment_groups', {
        user_id: args.p_user_id, appointment_date: args.p_appointment_date, start_time: clock(start), request_key: args.p_request_key
      });
      slot = start;
      const ids = items.map((item, index) => {
        const pet = this.rows.pets.find(row => String(row.id) === String(item.pet_id));
        const row = this.seed('appointments', {
          user_id: args.p_user_id, pet_id: pet.id, pet_name: pet.name, service_type: item.service_type,
          estimated_duration_minutes: Number(item.duration_minutes), appointment_date: args.p_appointment_date,
          appointment_time: clock(slot), status: 'Pending', group_id: group.id, group_position: index + 1
        });
        slot += Number(item.duration_minutes);
        return row.id;
      });
      return { data: { outcome: 'created', group_id: group.id, appointment_ids: ids }, error: null, status: 200 };
    }
    if (functionName === 'cancel_appointment_group_by_clinic') {
      if (!args.p_group_id || !args.p_handled_by) return this.error('22023', 'Invalid booking cancellation request');
      if (!this.rows.appointment_groups.some(group => String(group.id) === String(args.p_group_id))) {
        return { data: { outcome: 'not_found' }, error: null, status: 200 };
      }
      const changed = this.rows.appointments
        .filter(row => String(row.group_id) === String(args.p_group_id) && ['Pending', 'Approved'].includes(row.status))
        .sort((first, second) => first.group_position - second.group_position);
      const at = new Date().toISOString();
      changed.forEach(row => Object.assign(row, { status: 'Cancelled', handled_by: args.p_handled_by, cancelled_at: at, cancelled_by: args.p_handled_by }));
      return { data: { outcome: changed.length ? 'cancelled' : 'nothing_to_cancel', appointment_ids: changed.map(row => row.id) }, error: null, status: 200 };
    }
    if (functionName === 'reschedule_appointment_if_available') {
      if (!args.p_appointment_id || !args.p_new_date || !args.p_new_time || !args.p_handled_by
          || !['Pending', 'Approved'].includes(args.p_expected_status) || !args.p_expected_date || !args.p_expected_time) {
        return this.error('22023', 'Invalid reschedule request');
      }
      const appointment = this.rows.appointments.find(row => String(row.id) === String(args.p_appointment_id));
      if (!appointment) return { data: { outcome: 'not_found' }, error: null, status: 200 };
      if (appointment.status !== args.p_expected_status
          || String(appointment.appointment_date).slice(0, 10) !== String(args.p_expected_date).slice(0, 10)
          || minutesOf(appointment.appointment_time) !== minutesOf(args.p_expected_time)) {
        return { data: { outcome: 'stale' }, error: null, status: 200 };
      }
      const duration = Number(appointment.estimated_duration_minutes);
      if (!Number.isInteger(duration) || duration < 5 || duration > 480) return { data: { outcome: 'invalid_duration' }, error: null, status: 200 };
      const start = minutesOf(args.p_new_time);
      if (start + duration > 24 * 60) return { data: { outcome: 'past_end_of_day' }, error: null, status: 200 };
      if (overlapsActive(args.p_new_date, start, start + duration, appointment.id)) return { data: { outcome: 'conflict' }, error: null, status: 200 };
      const previous = { previous_date: appointment.appointment_date, previous_time: appointment.appointment_time };
      Object.assign(appointment, { appointment_date: args.p_new_date, appointment_time: clock(start), handled_by: args.p_handled_by });
      return { data: { outcome: 'updated', appointment_id: appointment.id, ...previous }, error: null, status: 200 };
    }
    if (functionName !== 'cancel_appointment_for_owner') {
      return this.error('42883', `function ${functionName} does not exist`);
    }

    const appointment = this.rows.appointments.find(row =>
      String(row.id) === String(args.p_appointment_id)
      && String(row.user_id) === String(args.p_owner_id)
      && String(row.status) === String(args.p_expected_status)
    );
    if (!appointment || !['Pending', 'Approved'].includes(String(args.p_expected_status))) return { data: false, error: null, status: 200 };

    const { getAppointmentStartTimestamp } = require('../../validators/appointmentsValidator');
    const start = getAppointmentStartTimestamp(appointment.appointment_date, appointment.appointment_time, 'Asia/Manila');
    if (!Number.isFinite(start) || start - Date.now() < 2 * 60 * 60 * 1000) return { data: false, error: null, status: 200 };
    appointment.status = 'Cancelled';
    appointment.cancelled_at = new Date().toISOString();
    appointment.cancelled_by = args.p_owner_id;
    return { data: true, error: null, status: 200 };
  }

  checkColumns(definition, columns, code) {
    const unknown = columns.find(column => !definition.columns.includes(column));
    if (!unknown) return null;
    if (code === 'PGRST204') {
      return this.error('PGRST204', `Could not find the '${unknown}' column of '${definition.name}' in the schema cache`);
    }
    return this.error('42703', `column ${definition.name}.${unknown} does not exist`);
  }

  checkUuids(definition, entries) {
    const bad = entries.find(([column, value]) => (
      (definition.uuidColumns || []).includes(column) &&
      value !== null && value !== undefined && !UUID_PATTERN.test(String(value))
    ));
    return bad ? this.error('22P02', `invalid input syntax for type uuid: "${bad[1]}"`) : null;
  }

  checkUnique(definition, candidateRows, untouchedRows) {
    for (const index of definition.uniqueIndexes || []) {
      const seen = new Set();
      for (const original of [...untouchedRows, ...candidateRows]) {
        const row = index.derive ? index.derive(original) : original;
        if (index.where && !index.where(row)) continue;
        const key = index.columns.map(column => index.normalize ? String(row[column]).trim().toLocaleLowerCase('en') : row[column]);
        if (key.some(part => part === null || part === undefined)) continue;
        const serialized = JSON.stringify(key);
        if (seen.has(serialized)) {
          return this.error('23505', `duplicate key value violates unique constraint "${index.name}"`);
        }
        seen.add(serialized);
      }
    }
    return null;
  }

  // Rows a write returns: like PostgREST, .single()/.maybeSingle() turn the list into one object (or null)
  returned(query, definition, rows) {
    if (!query.returning) return { data: null, error: null };
    const projected = this.project(definition, rows, query.columns);
    if (!query.singleMode) return { data: projected, error: null };
    if (projected.length > 1 || (projected.length === 0 && query.singleMode === 'single')) {
      return this.error('PGRST116', 'JSON object requested, multiple (or no) rows returned');
    }
    return { data: projected[0] || null, error: null };
  }

  project(definition, rows, columnsText) {
    const columns = columnsText === '*' ? definition.columns : columnsText.split(',').map(column => column.trim()).filter(Boolean);
    return rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] === undefined ? null : row[column]])));
  }

  async run(query) {
    const definition = this.definitions[query.tableName];
    this.log.push({ table: query.tableName, action: query.action });
    if (!definition) return this.error('42P01', `relation "public.${query.tableName}" does not exist`);

    const interceptorIndex = this.interceptors.findIndex(entry => entry.table === query.tableName && entry.action === query.action);
    if (interceptorIndex >= 0) {
      const [interceptor] = this.interceptors.splice(interceptorIndex, 1);
      const outcome = await interceptor.handler(query, this);
      if (outcome) return outcome;
    }

    const selectedColumns = query.columns === '*' ? [] : query.columns.split(',').map(column => column.trim()).filter(Boolean);
    const columnError = this.checkColumns(definition, [...selectedColumns, ...query.filters.filter(filter => filter.column).map(filter => filter.column), ...query.orders.map(order => order.column)], '42703');
    if (columnError) return columnError;

    const uuidError = this.checkUuids(definition, query.filters.flatMap(filter => filter.values.map(value => [filter.column, value])));
    if (uuidError) return uuidError;

    const table = this.rows[query.tableName];
    const matches = row => query.filters.every(filter => (filter.rowTest ? filter.rowTest(row) : filter.test(row[filter.column])));

    if (query.action === 'insert') {
      const payloadColumns = [...new Set(query.payload.flatMap(row => Object.keys(row)))];
      const payloadError = this.checkColumns(definition, payloadColumns, 'PGRST204') ||
        this.checkUuids(definition, query.payload.flatMap(row => Object.entries(row)));
      if (payloadError) return payloadError;

      const newRows = query.payload.map(row => this.applyDefaults(definition, { ...row }));
      const uniqueError = this.checkUnique(definition, newRows, table);
      if (uniqueError) return uniqueError;

      table.push(...newRows);
      return { ...this.returned(query, definition, newRows), status: 201 };
    }

    if (query.action === 'upsert') {
      const payloadColumns = [...new Set(query.payload.flatMap(row => Object.keys(row)))];
      const payloadError = this.checkColumns(definition, payloadColumns, 'PGRST204') ||
        this.checkUuids(definition, query.payload.flatMap(row => Object.entries(row)));
      if (payloadError) return payloadError;

      const written = query.payload.map(row => {
        const existing = table.find(stored => sameValue(stored[query.onConflict], row[query.onConflict]));
        if (existing) return Object.assign(existing, row);
        const created = this.applyDefaults(definition, { ...row });
        table.push(created);
        return created;
      });
      return { ...this.returned(query, definition, written), status: 201 };
    }

    if (query.action === 'update') {
      const payloadError = this.checkColumns(definition, Object.keys(query.payload), 'PGRST204') ||
        this.checkUuids(definition, Object.entries(query.payload));
      if (payloadError) return payloadError;

      const targets = table.filter(matches);
      const updatedRows = targets.map(row => ({ ...row, ...query.payload }));
      const uniqueError = this.checkUnique(definition, updatedRows, table.filter(row => !targets.includes(row)));
      if (uniqueError) return uniqueError;

      targets.forEach((row, index) => Object.assign(row, updatedRows[index]));
      return { ...this.returned(query, definition, targets), status: 200 };
    }

    if (query.action === 'delete') {
      const targets = table.filter(matches);
      this.rows[query.tableName] = table.filter(row => !targets.includes(row));
      return { data: query.returning ? this.project(definition, targets, query.columns) : null, error: null, status: 200 };
    }

    let results = table.filter(matches);
    query.orders.slice().reverse().forEach(({ column, ascending, nullsFirst }) => {
      results = results.slice().sort((first, second) => {
        const firstIsNull = first[column] === null || first[column] === undefined;
        const secondIsNull = second[column] === null || second[column] === undefined;
        if (firstIsNull || secondIsNull) {
          if (firstIsNull === secondIsNull) return 0;
          return firstIsNull === nullsFirst ? -1 : 1;
        }
        const order = compare(first[column], second[column]) ?? 0;
        return ascending ? order : -order;
      });
    });
    const count = results.length;
    if (query.offsetCount) results = results.slice(query.offsetCount);
    if (query.limitCount !== null) results = results.slice(0, query.limitCount);

    if (query.head) return { data: null, error: null, count: query.countMode ? count : null };

    const projected = this.project(definition, results, query.columns);
    if (query.singleMode) {
      if (projected.length > 1) return this.error('PGRST116', 'JSON object requested, multiple (or no) rows returned');
      if (projected.length === 0 && query.singleMode === 'single') return this.error('PGRST116', 'JSON object requested, multiple (or no) rows returned');
      return { data: projected[0] || null, error: null, count: query.countMode ? count : null };
    }

    return { data: projected, error: null, count: query.countMode ? count : null };
  }
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// PetHub tables as the code uses them. The legacy payment schema stays in the real database (the payments table and
// appointments.deposit_required / payment_status, from database/migrations/2026-10-17_paymongo_deposits.sql), so it is
// modelled here too: the application must work alongside it without reading or writing it.
// users has the columns the live database showed on 2026-10-20 plus the optional profile columns from
// database/migrations/2026-10-20_users_profile_fields.sql; { usersProfileColumns: false } leaves those out, like the
// database before that migration.
const USERS_LIVE_COLUMNS = [
  'id', 'fullname', 'email', 'password', 'role', 'created_at', 'is_verified',
  'phone_number', 'profile_image', 'last_login_at', 'status', 'deleted_at'
];
const USERS_PROFILE_MIGRATION_COLUMNS = ['date_of_birth', 'gender', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'];

function createPetHubDatabase({ usersProfileColumns = true } = {}) {
  const definitions = {
    users: {
      columns: usersProfileColumns ? [...USERS_LIVE_COLUMNS, ...USERS_PROFILE_MIGRATION_COLUMNS] : [...USERS_LIVE_COLUMNS],
      uuidColumns: ['id'],
      defaults: { id: uuid, created_at: now, role: () => 'user', is_verified: () => false, status: () => 'Active' }
    },
    email_verifications: {
      columns: ['id', 'user_id', 'verification_code', 'expires_at', 'is_verified', 'created_at'],
      uuidColumns: ['id', 'user_id'],
      defaults: { id: uuid, created_at: now }
    },
    pets: {
      columns: ['id', 'user_id', 'name', 'species', 'breed', 'age', 'created_at'],
      uuidColumns: ['id', 'user_id'],
      defaults: { id: uuid, created_at: now }
    },
    pet_breed_catalog: {
      columns: ['id', 'species', 'name', 'recognition_status', 'source_organization', 'source_url', 'source_reviewed_at', 'is_active', 'created_by', 'updated_by', 'created_at', 'updated_at'],
      uuidColumns: ['id', 'created_by', 'updated_by'],
      defaults: { id: uuid, recognition_status: () => 'unverified', is_active: () => true, created_at: now, updated_at: now },
      uniqueIndexes: [{ name: 'pet_breed_catalog_species_name_ci_key', columns: ['species', 'name'], normalize: true }]
    },
    owner_pet_weight_reports: {
      columns: ['id', 'pet_id', 'user_id', 'weight_kg', 'source', 'recorded_at', 'created_at'],
      uuidColumns: ['id', 'pet_id', 'user_id'],
      defaults: { id: uuid, source: () => 'owner_reported', recorded_at: now, created_at: now }
    },
    appointments: {
      columns: [
        'id', 'user_id', 'pet_id', 'pet_name', 'service_type', 'estimated_duration_minutes', 'appointment_date',
        'appointment_time', 'status', 'handled_by', 'created_at', 'appointment_reference', 'payment_status',
        'confirmed_at', 'cancelled_at', 'deposit_required', 'cancelled_by', 'group_id', 'group_position'
      ],
      uuidColumns: ['id', 'user_id', 'pet_id', 'handled_by', 'cancelled_by', 'group_id'],
      // Database defaults (payment_status and deposit_required are legacy columns the application no longer sets)
      defaults: {
        id: uuid,
        created_at: now,
        status: () => 'Pending',
        payment_status: () => 'Pending',
        deposit_required: () => false,
        group_id: () => null,
        group_position: () => null
      }
    },
    appointment_groups: {
      columns: ['id', 'user_id', 'appointment_date', 'start_time', 'scheduling', 'request_key', 'created_at'],
      uuidColumns: ['id', 'user_id'],
      defaults: { id: uuid, created_at: now, scheduling: () => 'sequential' }
    },
    care_recommendation_rules: {
      columns: ['id', 'service_id', 'species', 'min_interval_days', 'max_interval_days', 'guidance_type', 'description', 'explanation', 'is_active', 'version', 'created_by', 'updated_by', 'created_at', 'updated_at'],
      uuidColumns: ['id', 'service_id', 'created_by', 'updated_by'],
      defaults: { id: uuid, species: () => null, explanation: () => '', is_active: () => true, version: () => 1, created_at: now, updated_at: now },
      uniqueIndexes: [{ name: 'care_rules_service_species_key', columns: ['service_id', 'species_key'], derive: row => ({ ...row, species_key: row.species || 'All' }) }]
    },
    pet_care_recommendations: {
      columns: ['id', 'pet_id', 'user_id', 'service_id', 'service_name', 'source_appointment_id', 'rule_id', 'basis', 'guidance_type', 'service_date', 'due_from', 'due_to', 'explanation', 'status', 'set_by', 'created_at', 'updated_at', 'acknowledged_at', 'dismissed_at'],
      uuidColumns: ['id', 'pet_id', 'user_id', 'service_id', 'source_appointment_id', 'rule_id', 'set_by'],
      defaults: { id: uuid, status: () => 'active', created_at: now, updated_at: now, service_id: () => null, source_appointment_id: () => null, rule_id: () => null, guidance_type: () => null, due_from: () => null, due_to: () => null, set_by: () => null, acknowledged_at: () => null, dismissed_at: () => null },
      uniqueIndexes: [{ name: 'pet_care_one_open_per_source', columns: ['source_appointment_id'], where: row => row.source_appointment_id && row.status !== 'superseded' }]
    },
    pethub_service_catalog: {
      columns: ['id', 'service_key', 'name', 'description', 'category', 'species', 'duration_minutes', 'online_booking_enabled', 'display_order', 'version', 'created_by', 'updated_by', 'created_at', 'updated_at'],
      uuidColumns: ['id', 'created_by', 'updated_by'],
      defaults: { id: uuid, description: () => '', species: () => [], duration_minutes: () => null, online_booking_enabled: () => false, version: () => 1, created_at: now, updated_at: now },
      uniqueIndexes: [
        { name: 'pethub_service_catalog_service_key_key', columns: ['service_key'] },
        { name: 'pethub_service_catalog_name_ci_key', columns: ['name'], normalize: true }
      ]
    },
    // Legacy table kept for its historical rows; nothing in the application uses it
    payments: {
      columns: [
        'id', 'appointment_id', 'user_id', 'amount', 'payment_method', 'payment_reference', 'payment_status',
        'receipt_url', 'paid_at', 'created_at',
        'provider_checkout_session_id', 'provider_payment_id', 'expires_at', 'receipt_email_sent_at'
      ],
      uuidColumns: ['id', 'appointment_id', 'user_id'],
      defaults: { id: uuid, created_at: now, payment_status: () => 'Pending' },
      uniqueIndexes: [{ name: 'payments_pkey', columns: ['id'] }]
    },
    password_resets: {
      columns: ['id', 'user_id', 'reset_token', 'expires_at', 'used_at', 'attempts', 'created_at'],
      uuidColumns: ['id', 'user_id'],
      defaults: { id: uuid, created_at: now, used_at: () => null, attempts: () => 0 }
    },
    activity_logs: {
      columns: ['id', 'actor_id', 'user_id', 'target_table', 'target_id', 'action', 'details', 'event_type', 'created_at'],
      defaults: { id: uuid, created_at: now, event_type: () => null }
    },
    medical_records: {
      columns: ['id', 'pet_id', 'appointment_id', 'record_date', 'created_at', 'created_by', 'weight', 'vaccination_status', 'treatment', 'medical_notes'],
      uuidColumns: ['id', 'pet_id', 'appointment_id', 'created_by'],
      defaults: { id: uuid, created_at: now, appointment_id: () => null },
      uniqueIndexes: [{ name: 'medical_records_one_per_appointment_key', columns: ['appointment_id'], where: row => row.appointment_id !== null && row.appointment_id !== undefined }]
    },
    // database/migrations/2026-10-24_contact_cancellation_email_log.sql added user_id, subject and reply_message
    contact_messages: {
      columns: ['id', 'user_id', 'fullname', 'email', 'subject', 'message', 'status', 'created_at', 'reply_message', 'replied_at', 'handled_by'],
      uuidColumns: ['id', 'user_id', 'handled_by'],
      defaults: { id: uuid, created_at: now, status: () => 'Unread', user_id: () => null, subject: () => null, reply_message: () => null, replied_at: () => null, handled_by: () => null }
    },
    email_logs: {
      columns: ['id', 'user_id', 'email_type', 'recipient_email', 'subject', 'status', 'error_message', 'sent_at', 'created_at', 'appointment_id', 'contact_message_id'],
      uuidColumns: ['id', 'user_id', 'appointment_id', 'contact_message_id'],
      defaults: { id: uuid, created_at: now, status: () => 'Pending', error_message: () => null, sent_at: () => null, appointment_id: () => null, contact_message_id: () => null },
      uniqueIndexes: [
        { name: 'email_logs_one_per_appointment_type', columns: ['appointment_id', 'email_type'] },
        { name: 'email_logs_one_per_contact_message_type', columns: ['contact_message_id', 'email_type'] }
      ]
    },
    // database/migrations/2026-10-24_user_sessions.sql: one row per login, named by the signed token
    user_sessions: {
      columns: ['id', 'user_id', 'created_at', 'expires_at', 'revoked_at', 'revoked_reason'],
      uuidColumns: ['id', 'user_id'],
      defaults: { id: uuid, created_at: now, revoked_at: () => null, revoked_reason: () => null }
    },
    system_settings: {
      columns: ['id', 'setting_key', 'setting_value', 'updated_at'],
      uuidColumns: ['id'],
      defaults: { id: uuid, updated_at: now },
      uniqueIndexes: [{ name: 'system_settings_setting_key_key', columns: ['setting_key'] }]
    }
  };

  Object.entries(definitions).forEach(([name, definition]) => { definition.name = name; });
  const database = new FakeDatabase(definitions);
  const { SERVICE_CATALOG } = require('../../constants/services');
  SERVICE_CATALOG.forEach((entry, index) => {
    database.seed('pethub_service_catalog', {
      service_key: entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: entry.name,
      description: entry.description,
      category: entry.category,
      species: [...entry.species],
      display_order: index + 1
    });
  });
  const { BREED_CATALOG_SEED } = require('../../constants/breedCatalog');
  BREED_CATALOG_SEED.forEach(entry => database.seed('pet_breed_catalog', entry));
  return database;
}

module.exports = {
  createPetHubDatabase,
  USERS_PROFILE_MIGRATION_COLUMNS
};
