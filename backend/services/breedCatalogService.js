const breedCatalogRepository = require('../repositories/breedCatalogRepository');
const { logAdminActivity } = require('../utils/activityLogger');
const { validateBreedCatalogListQuery, validateBreedCatalogPageQuery, validateBreedCatalogCreate, validateBreedCatalogUpdate } = require('../validators/breedCatalogValidator');
const { fetchPage } = require('../utils/pagination');

const CATALOG_UNAVAILABLE = { statusCode: 503, body: { success: false, error: 'The breed catalog is not available until its database update is applied.' } };
const DUPLICATE_BREED = { statusCode: 409, body: { success: false, error: 'A breed with this name already exists for that species.' } };

function normalizedName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

// GET /admin/breeds?page=&page_size=&species=&status=&q=&sort= : one page of the catalog, filtered and sorted in the
// database, with the total and page count for the page navigation
async function getBreedCatalog(req) {
  const validation = validateBreedCatalogPageQuery(req.query);
  if (validation.error) return validation.error;
  const { filters, page, pageSize } = validation;
  const result = await fetchPage(range => breedCatalogRepository.listPage(filters, range), page, pageSize);
  if (result.error) return CATALOG_UNAVAILABLE;
  return { statusCode: 200, body: { success: true, breeds: result.rows, ...result.info, filters } };
}

async function listOwnerBreeds(req) {
  const species = String(req.query?.species || '').trim();
  const validation = validateBreedCatalogListQuery({ species });
  if (validation.error) return validation.error;
  if (!validation.species) return { statusCode: 400, body: { success: false, error: 'Choose Dog or Cat.', field: 'species' } };
  const { data, error } = await breedCatalogRepository.list({ species: validation.species, activeOnly: true });
  if (error) return CATALOG_UNAVAILABLE;
  return { statusCode: 200, body: { success: true, species: validation.species, breeds: (data || []).map(({ id, species: kind, name, recognition_status, source_organization }) => ({ id, species: kind, name, recognition_status, source_organization })) } };
}

async function createBreed(req) {
  const validation = validateBreedCatalogCreate(req.body);
  if (validation.error) return validation.error;
  const { data: sameSpecies, error: listError } = await breedCatalogRepository.listBySpecies(validation.species);
  if (listError) return CATALOG_UNAVAILABLE;
  if ((sameSpecies || []).some(entry => normalizedName(entry.name) === normalizedName(validation.name))) return DUPLICATE_BREED;

  const actorId = String(req.authUserId || '').trim();
  const payload = {
    species: validation.species,
    name: validation.name,
    recognition_status: 'unverified',
    source_organization: validation.sourceOrganization,
    source_url: validation.sourceUrl,
    source_reviewed_at: null,
    is_active: true,
    created_by: actorId,
    updated_by: actorId,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await breedCatalogRepository.create(payload);
  if (error) {
    if (error.code === '23505') return DUPLICATE_BREED;
    return CATALOG_UNAVAILABLE;
  }
  const breed = data?.[0];
  if (breed) await logAdminActivity(actorId, 'pet_breed_catalog', breed.id, `Added ${breed.species} breed ${breed.name}`);
  return { statusCode: 201, body: { success: true, breed } };
}

async function updateBreed(req) {
  const validation = validateBreedCatalogUpdate(req.params, req.body);
  if (validation.error) return validation.error;
  const { data: existing, error: findError } = await breedCatalogRepository.findById(validation.id);
  if (findError) return CATALOG_UNAVAILABLE;
  if (!existing) return { statusCode: 404, body: { success: false, error: 'Breed entry not found.' } };

  if (validation.changes.name && normalizedName(validation.changes.name) !== normalizedName(existing.name)) {
    const { data: sameSpecies, error } = await breedCatalogRepository.listBySpecies(existing.species);
    if (error) return CATALOG_UNAVAILABLE;
    if ((sameSpecies || []).some(entry => entry.id !== existing.id && normalizedName(entry.name) === normalizedName(validation.changes.name))) return DUPLICATE_BREED;
  }

  const changes = {
    ...validation.changes,
    updated_by: String(req.authUserId || '').trim(),
    updated_at: new Date().toISOString()
  };
  const { data, error } = await breedCatalogRepository.update(validation.id, changes);
  if (error) return error.code === '23505' ? DUPLICATE_BREED : CATALOG_UNAVAILABLE;
  if (!data?.length) return { statusCode: 404, body: { success: false, error: 'Breed entry not found.' } };
  const breed = data[0];
  const action = validation.changes.is_active === false ? 'deactivated' : validation.changes.is_active === true ? 'enabled' : 'renamed';
  await logAdminActivity(String(req.authUserId || '').trim(), 'pet_breed_catalog', breed.id, `${action} ${breed.species} breed ${breed.name}`);
  return { statusCode: 200, body: { success: true, breed } };
}

module.exports = { getBreedCatalog, listOwnerBreeds, createBreed, updateBreed };
