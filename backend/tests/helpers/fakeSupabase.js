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

function likeToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
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
    if (operator !== 'is') throw new Error(`Fake Supabase: not(${operator}) is not supported`);
    return this.addFilter(column, [], stored => !(value === null ? stored === null || stored === undefined : stored === value));
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
    return { from: tableName => new FakeQuery(this, tableName) };
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
      for (const row of [...untouchedRows, ...candidateRows]) {
        if (index.where && !index.where(row)) continue;
        const key = index.columns.map(column => row[column]);
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
    const columnError = this.checkColumns(definition, [...selectedColumns, ...query.filters.map(filter => filter.column), ...query.orders.map(order => order.column)], '42703');
    if (columnError) return columnError;

    const uuidError = this.checkUuids(definition, query.filters.flatMap(filter => filter.values.map(value => [filter.column, value])));
    if (uuidError) return uuidError;

    const table = this.rows[query.tableName];
    const matches = row => query.filters.every(filter => filter.test(row[filter.column]));

    if (query.action === 'insert') {
      const payloadColumns = [...new Set(query.payload.flatMap(row => Object.keys(row)))];
      const payloadError = this.checkColumns(definition, payloadColumns, 'PGRST204') ||
        this.checkUuids(definition, query.payload.flatMap(row => Object.entries(row)));
      if (payloadError) return payloadError;

      const newRows = query.payload.map(row => this.applyDefaults(definition, { ...row }));
      const uniqueError = this.checkUnique(definition, newRows, table);
      if (uniqueError) return uniqueError;

      table.push(...newRows);
      return { data: query.returning ? this.project(definition, newRows, query.columns) : null, error: null, status: 201 };
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
      return { data: query.returning ? this.project(definition, targets, query.columns) : null, error: null, status: 200 };
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
    appointments: {
      columns: [
        'id', 'user_id', 'pet_id', 'pet_name', 'service_type', 'estimated_duration_minutes', 'appointment_date',
        'appointment_time', 'status', 'handled_by', 'created_at', 'appointment_reference', 'payment_status',
        'confirmed_at', 'cancelled_at', 'deposit_required'
      ],
      uuidColumns: ['id', 'user_id', 'pet_id', 'handled_by'],
      // Database defaults (payment_status and deposit_required are legacy columns the application no longer sets)
      defaults: {
        id: uuid,
        created_at: now,
        status: () => 'Pending',
        payment_status: () => 'Pending',
        deposit_required: () => false
      }
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
      columns: ['id', 'actor_id', 'user_id', 'target_table', 'target_id', 'action', 'details', 'created_at'],
      defaults: { id: uuid, created_at: now }
    },
    medical_records: {
      columns: ['id', 'pet_id', 'record_date', 'created_at', 'created_by', 'weight', 'vaccination_status', 'treatment', 'medical_notes'],
      uuidColumns: ['id', 'pet_id'],
      defaults: { id: uuid, created_at: now }
    },
    contact_messages: {
      columns: ['id', 'fullname', 'email', 'message', 'status', 'created_at'],
      defaults: { id: uuid, created_at: now }
    }
  };

  Object.entries(definitions).forEach(([name, definition]) => { definition.name = name; });
  return new FakeDatabase(definitions);
}

module.exports = {
  createPetHubDatabase,
  USERS_PROFILE_MIGRATION_COLUMNS
};
