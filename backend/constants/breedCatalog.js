const DOG_SOURCE = 'American Kennel Club';
const DOG_SOURCE_URL = 'https://www.akc.org/dog-breeds/';
const CAT_SOURCE = "Cat Fanciers' Association";
const CAT_SOURCE_URL = 'https://cfa.org/breeds/';
const BREED_NAME_MAX_LENGTH = 50;
const BREED_RECOGNITION_STATUSES = Object.freeze([
  'recognized', 'provisional', 'preliminary', 'experimental', 'developing', 'unverified'
]);

// Initial reviewed selection from the organizations' public breed lists (reviewed 2026-10-22).
// The source organizations have different scopes; this starter catalog does not claim universal coverage.
const RECOGNIZED_DOG_BREEDS = Object.freeze([
  'Affenpinscher', 'Afghan Hound', 'Airedale Terrier', 'Akita', 'Alaskan Malamute',
  'American Eskimo Dog', 'American Staffordshire Terrier', 'Australian Cattle Dog',
  'Australian Shepherd', 'Basenji', 'Basset Hound', 'Beagle', 'Belgian Malinois',
  'Bernese Mountain Dog', 'Bichon Frise', 'Border Collie', 'Boston Terrier', 'Boxer',
  'Bulldog', 'Cavalier King Charles Spaniel', 'Chihuahua', 'Cocker Spaniel', 'Collie',
  'Dachshund', 'Doberman Pinscher', 'English Springer Spaniel', 'French Bulldog',
  'German Shepherd Dog', 'German Shorthaired Pointer', 'Golden Retriever', 'Great Dane',
  'Havanese', 'Labrador Retriever', 'Maltese', 'Miniature Schnauzer', 'Papillon',
  'Pembroke Welsh Corgi', 'Pomeranian', 'Poodle', 'Pug', 'Rottweiler', 'Shetland Sheepdog',
  'Shih Tzu', 'Siberian Husky', 'Staffordshire Bull Terrier', 'Weimaraner',
  'West Highland White Terrier', 'Yorkshire Terrier'
]);

const RECOGNIZED_CAT_BREEDS = Object.freeze([
  'Abyssinian', 'American Bobtail', 'American Curl', 'American Shorthair', 'American Wirehair',
  'Balinese', 'Bengal', 'Birman', 'Bombay', 'British Shorthair', 'Burmese', 'Burmilla',
  'Chartreux', 'Cornish Rex', 'Devon Rex', 'Egyptian Mau', 'Exotic', 'Havana Brown',
  'Himalayan', 'Japanese Bobtail', 'Korat', 'LaPerm', 'Maine Coon', 'Manx', 'Norwegian Forest Cat',
  'Ocicat', 'Oriental', 'Persian', 'Ragdoll', 'Russian Blue', 'Scottish Fold', 'Selkirk Rex',
  'Siamese', 'Siberian', 'Singapura', 'Somali', 'Sphynx', 'Tonkinese', 'Turkish Angora', 'Turkish Van'
]);

const BREED_CATALOG_SEED = Object.freeze([
  ...RECOGNIZED_DOG_BREEDS.map(name => ({ species: 'Dog', name, recognition_status: 'recognized', source_organization: DOG_SOURCE, source_url: DOG_SOURCE_URL })),
  ...RECOGNIZED_CAT_BREEDS.map(name => ({ species: 'Cat', name, recognition_status: 'recognized', source_organization: CAT_SOURCE, source_url: CAT_SOURCE_URL })),
  // Common local owner terms retained as unverified descriptors, not official recognition claims.
  { species: 'Dog', name: 'Aspin', recognition_status: 'unverified', source_organization: 'PetHub local descriptor', source_url: null },
  { species: 'Cat', name: 'Puspin', recognition_status: 'unverified', source_organization: 'PetHub local descriptor', source_url: null }
]);

module.exports = {
  BREED_NAME_MAX_LENGTH,
  BREED_RECOGNITION_STATUSES,
  BREED_CATALOG_SEED,
  RECOGNIZED_DOG_BREEDS,
  RECOGNIZED_CAT_BREEDS,
  DOG_SOURCE,
  DOG_SOURCE_URL,
  CAT_SOURCE,
  CAT_SOURCE_URL
};
