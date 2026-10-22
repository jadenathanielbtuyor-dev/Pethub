const { trimValue, hasValue } = require('./commonValidator');
const { BREED_NAME_MAX_LENGTH } = require('../constants/breedCatalog');

const VALID_SPECIES = ['Dog', 'Cat'];

function normalizeSpecies(value) {
  const species = trimValue(value).toLowerCase();
  return VALID_SPECIES.find(option => option.toLowerCase() === species) || '';
}

function normalizeBreedName(value) {
  return trimValue(value).replace(/\s+/g, ' ');
}

function validateBreedCatalogListQuery(query = {}) {
  const species = hasValue(query.species) ? normalizeSpecies(query.species) : '';
  if (hasValue(query.species) && !species) return { error: { statusCode: 400, body: { error: 'Species must be Dog or Cat.', field: 'species' } } };
  return { species };
}

function validateBreedCatalogCreate(body = {}) {
  const species = normalizeSpecies(body.species);
  const name = normalizeBreedName(body.name);
  if (!species) return { error: { statusCode: 400, body: { error: 'Choose Dog or Cat.', field: 'species' } } };
  if (!name || name.length > BREED_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return { error: { statusCode: 400, body: { error: `Breed name must be 1 to ${BREED_NAME_MAX_LENGTH} characters.`, field: 'name' } } };
  }
  const sourceOrganization = normalizeBreedName(body.source_organization || '');
  if (sourceOrganization.length > 120) return { error: { statusCode: 400, body: { error: 'Source must be 120 characters or fewer.', field: 'source_organization' } } };
  let sourceUrl = trimValue(body.source_url);
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || sourceUrl.length > 500) throw new Error('invalid');
      sourceUrl = url.toString();
    } catch (error) {
      return { error: { statusCode: 400, body: { error: 'Enter a valid http or https source link.', field: 'source_url' } } };
    }
  }
  return { species, name, sourceOrganization: sourceOrganization || null, sourceUrl: sourceUrl || null };
}

function validateBreedCatalogUpdate(params = {}, body = {}) {
  const id = trimValue(params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { error: { statusCode: 404, body: { error: 'Breed entry not found.' } } };
  }
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasActive = Object.prototype.hasOwnProperty.call(body, 'is_active');
  if (!hasName && !hasActive) return { error: { statusCode: 400, body: { error: 'Change a breed name or selection status.' } } };
  const changes = {};
  if (hasName) {
    const name = normalizeBreedName(body.name);
    if (!name || name.length > BREED_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
      return { error: { statusCode: 400, body: { error: `Breed name must be 1 to ${BREED_NAME_MAX_LENGTH} characters.`, field: 'name' } } };
    }
    changes.name = name;
  }
  if (hasActive) {
    if (typeof body.is_active !== 'boolean') return { error: { statusCode: 400, body: { error: 'Selection status must be enabled or disabled.', field: 'is_active' } } };
    changes.is_active = body.is_active;
  }
  return { id, changes };
}

module.exports = {
  normalizeSpecies,
  normalizeBreedName,
  validateBreedCatalogListQuery,
  validateBreedCatalogCreate,
  validateBreedCatalogUpdate
};
