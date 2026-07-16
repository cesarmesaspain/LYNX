#include <pthread.h>
#include <ctype.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include "sqlite3.h"
#include "native_staging_schema.h"
#include "tree_sitter/api.h"

extern const TSLanguage *tree_sitter_c(void);
extern const TSLanguage *tree_sitter_cpp(void);

typedef struct {
  char *language;
  char *rel_path;
  char *abs_path;
  long size;
  char sha256[65];
} FileTask;

typedef struct {
  uint32_t state[8];
  uint64_t bit_length;
  uint8_t block[64];
  size_t block_length;
} Sha256;

static const uint32_t SHA256_K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
};

static uint32_t rotate_right(uint32_t value, unsigned shift) {
  return (value >> shift) | (value << (32U - shift));
}

static void sha256_transform(Sha256 *hash) {
  uint32_t words[64];
  for (int index = 0; index < 16; index++) {
    int offset = index * 4;
    words[index] = ((uint32_t)hash->block[offset] << 24) |
      ((uint32_t)hash->block[offset + 1] << 16) |
      ((uint32_t)hash->block[offset + 2] << 8) |
      hash->block[offset + 3];
  }
  for (int index = 16; index < 64; index++) {
    uint32_t s0 = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  uint32_t a = hash->state[0], b = hash->state[1], c = hash->state[2], d = hash->state[3];
  uint32_t e = hash->state[4], f = hash->state[5], g = hash->state[6], h = hash->state[7];
  for (int index = 0; index < 64; index++) {
    uint32_t s1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ (~e & g);
    uint32_t temp1 = h + s1 + choice + SHA256_K[index] + words[index];
    uint32_t s0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temp2 = s0 + majority;
    h = g; g = f; f = e; e = d + temp1;
    d = c; c = b; b = a; a = temp1 + temp2;
  }
  hash->state[0] += a; hash->state[1] += b; hash->state[2] += c; hash->state[3] += d;
  hash->state[4] += e; hash->state[5] += f; hash->state[6] += g; hash->state[7] += h;
}

static void sha256_bytes(const uint8_t *data, size_t length, char output[65]) {
  Sha256 hash = {
    .state = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19},
  };
  for (size_t index = 0; index < length; index++) {
    hash.block[hash.block_length++] = data[index];
    if (hash.block_length == 64) {
      sha256_transform(&hash);
      hash.bit_length += 512;
      hash.block_length = 0;
    }
  }
  hash.bit_length += (uint64_t)hash.block_length * 8;
  hash.block[hash.block_length++] = 0x80;
  if (hash.block_length > 56) {
    while (hash.block_length < 64) hash.block[hash.block_length++] = 0;
    sha256_transform(&hash);
    hash.block_length = 0;
  }
  while (hash.block_length < 56) hash.block[hash.block_length++] = 0;
  for (int index = 7; index >= 0; index--) hash.block[hash.block_length++] = (uint8_t)(hash.bit_length >> (index * 8));
  sha256_transform(&hash);
  for (int index = 0; index < 8; index++) snprintf(output + index * 8, 9, "%08x", hash.state[index]);
  output[64] = '\0';
}

typedef struct {
  int file_index;
  char *kind;
  char *name;
  char *qualified_name;
  char *declared_type;
  int start_line;
  int end_line;
  int is_exported;
  int is_entry_point;
} NodeObservation;

typedef struct {
  int file_index;
  char *enclosing_qn;
  char *callee_name;
  char *dispatch_kind;
  char *receiver_text;
  int start_line;
  int start_column;
} CallObservation;

typedef struct {
  int file_index;
  char *local_name;
  char *module_path;
  int is_local;
  int start_line;
} ImportObservation;

typedef struct {
  int file_index;
  char *enclosing_qn;
  char *referenced_name;
  int start_line;
  int start_column;
  int is_write;
} UsageObservation;

typedef struct {
  int file_index;
  char *macro_name;
  char *target_name;
  int start_line;
} MacroAliasObservation;

#define VECTOR(type, name) typedef struct { type *items; size_t length; size_t capacity; } name
VECTOR(NodeObservation, NodeVector);
VECTOR(CallObservation, CallVector);
VECTOR(ImportObservation, ImportVector);
VECTOR(UsageObservation, UsageVector);
VECTOR(MacroAliasObservation, MacroAliasVector);
VECTOR(char *, StringVector);

typedef struct {
  NodeVector nodes;
  CallVector calls;
  ImportVector imports;
  UsageVector usages;
  MacroAliasVector macro_aliases;
  int errors;
} WorkerBuffer;

typedef struct {
  FileTask *files;
  int file_count;
  const char *project;
  _Atomic int next_file;
  _Atomic int next_worker;
  WorkerBuffer *buffers;
} WorkContext;

typedef struct {
  char *qualified_name;
  char *rel_path;
} CallableCandidate;

typedef struct {
  const char *language;
  const char *name;
  CallableCandidate *implementations;
  CallableCandidate *headers;
  int implementation_count;
  int implementation_capacity;
  int header_count;
  int header_capacity;
} CallableRegistrySlot;

typedef struct {
  const char *qualified_name;
  const char *strategy;
  const char *matched_import;
  double confidence;
  int candidate_count;
} CallableResolution;

typedef struct {
  const char *language;
  const char *macro_name;
  const char *target_name;
  int target_count;
} MacroAliasSlot;

typedef struct {
  int file_id;
  char *source_qualified_name;
  int start_line;
  int start_column;
} ResolvedCallSlot;

typedef struct {
  char *qualified_name;
} CallableQnSlot;

static void *checked_realloc(void *pointer, size_t bytes) {
  void *next = realloc(pointer, bytes);
  if (!next) {
    fputs("native core: out of memory\n", stderr);
    exit(2);
  }
  return next;
}

static uint64_t hash_text_seed(const char *text, uint64_t hash) {
  for (const unsigned char *cursor = (const unsigned char *)text; *cursor; cursor++) {
    hash ^= *cursor;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

static size_t hash_capacity(size_t expected) {
  size_t capacity = 16;
  while (capacity < expected * 2) capacity <<= 1;
  return capacity;
}

static size_t callable_hash(const char *language, const char *name, size_t mask) {
  uint64_t hash = hash_text_seed(language, UINT64_C(1469598103934665603));
  hash = hash_text_seed(name, hash ^ UINT64_C(255));
  return (size_t)hash & mask;
}

static void macro_alias_add(
  MacroAliasSlot *slots,
  size_t capacity,
  const char *language,
  const char *macro_name,
  const char *target_name
) {
  size_t index = callable_hash(language, macro_name, capacity - 1);
  while (slots[index].macro_name) {
    if (strcmp(slots[index].language, language) == 0 &&
        strcmp(slots[index].macro_name, macro_name) == 0) {
      if (strcmp(slots[index].target_name, target_name) != 0) slots[index].target_count++;
      return;
    }
    index = (index + 1) & (capacity - 1);
  }
  slots[index] = (MacroAliasSlot){strdup(language), strdup(macro_name), strdup(target_name), 1};
}

static const char *macro_alias_unique(
  const MacroAliasSlot *slots,
  size_t capacity,
  const char *language,
  const char *macro_name
) {
  size_t index = callable_hash(language, macro_name, capacity - 1);
  while (slots[index].macro_name) {
    if (strcmp(slots[index].language, language) == 0 &&
        strcmp(slots[index].macro_name, macro_name) == 0) {
      return slots[index].target_count == 1 ? slots[index].target_name : NULL;
    }
    index = (index + 1) & (capacity - 1);
  }
  return NULL;
}

static void callable_registry_add(
  CallableRegistrySlot *slots,
  size_t capacity,
  const char *language,
  const char *name,
  const char *qualified_name,
  const char *rel_path,
  bool is_header
) {
  size_t index = callable_hash(language, name, capacity - 1);
  while (slots[index].name) {
    if (strcmp(slots[index].language, language) == 0 && strcmp(slots[index].name, name) == 0) {
      int *count = is_header ? &slots[index].header_count : &slots[index].implementation_count;
      int *candidate_capacity = is_header ? &slots[index].header_capacity
                                          : &slots[index].implementation_capacity;
      CallableCandidate **candidates = is_header ? &slots[index].headers
                                                  : &slots[index].implementations;
      if (*count == *candidate_capacity) {
        *candidate_capacity = *candidate_capacity ? *candidate_capacity * 2 : 2;
        *candidates = checked_realloc(*candidates,
          (size_t)*candidate_capacity * sizeof(**candidates));
      }
      (*candidates)[*count] = (CallableCandidate){strdup(qualified_name), strdup(rel_path)};
      (*count)++;
      return;
    }
    index = (index + 1) & (capacity - 1);
  }
  slots[index].language = strdup(language);
  slots[index].name = strdup(name);
  if (is_header) {
    slots[index].headers = checked_realloc(NULL, sizeof(*slots[index].headers));
    slots[index].headers[0] = (CallableCandidate){strdup(qualified_name), strdup(rel_path)};
    slots[index].header_capacity = 1;
    slots[index].header_count = 1;
  } else {
    slots[index].implementations = checked_realloc(NULL, sizeof(*slots[index].implementations));
    slots[index].implementations[0] = (CallableCandidate){strdup(qualified_name), strdup(rel_path)};
    slots[index].implementation_capacity = 1;
    slots[index].implementation_count = 1;
  }
}

static size_t path_stem_length(const char *path) {
  const char *slash = strrchr(path, '/');
  const char *dot = strrchr(path, '.');
  if (!dot || (slash && dot < slash)) return strlen(path);
  return (size_t)(dot - path);
}

static bool same_path_stem(const char *left, const char *right) {
  size_t left_length = path_stem_length(left);
  size_t right_length = path_stem_length(right);
  return left_length == right_length && strncmp(left, right, left_length) == 0;
}

static CallableResolution resolve_candidate_group(
  const CallableCandidate *candidates,
  int count,
  const StringVector *imports
) {
  if (count == 1) {
    bool import_reachable = false;
    if (imports) {
      for (size_t imported = 0; imported < imports->length; imported++) {
        if (same_path_stem(candidates[0].rel_path, imports->items[imported])) {
          import_reachable = true;
          break;
        }
      }
    }
    return (CallableResolution){candidates[0].qualified_name,
      "global_unique_name_same_language", NULL,
      imports && imports->length > 0 && !import_reachable ? 0.4875 : 0.75, 1};
  }
  const CallableCandidate *match = NULL;
  const char *matched_import = NULL;
  int matched = 0;
  if (imports) {
    for (int candidate = 0; candidate < count; candidate++) {
      for (size_t imported = 0; imported < imports->length; imported++) {
        if (same_path_stem(candidates[candidate].rel_path, imports->items[imported])) {
          match = &candidates[candidate];
          matched_import = imports->items[imported];
          matched++;
          break;
        }
      }
    }
  }
  if (matched == 1) {
    double confidence = 0.55 * (count > 3 ? 3.0 / (double)count : 1.0);
    return (CallableResolution){match->qualified_name, "import_reachable_candidate",
      matched_import, confidence, count};
  }
  return (CallableResolution){0};
}

static CallableResolution callable_registry_resolve(
  const CallableRegistrySlot *slots,
  size_t capacity,
  const char *language,
  const char *name,
  const StringVector *imports
) {
  size_t index = callable_hash(language, name, capacity - 1);
  while (slots[index].name) {
    if (strcmp(slots[index].language, language) == 0 && strcmp(slots[index].name, name) == 0) {
      if (slots[index].implementation_count > 0) {
        return resolve_candidate_group(slots[index].implementations,
          slots[index].implementation_count, imports);
      }
      if (slots[index].header_count > 0) {
        return resolve_candidate_group(slots[index].headers, slots[index].header_count, imports);
      }
      return (CallableResolution){0};
    }
    index = (index + 1) & (capacity - 1);
  }
  return (CallableResolution){0};
}

static char *child_qualified_name(const char *parent, const char *name);

static bool member_candidate_matches(
  const char *qualified_name, const char *declared_type, const char *callee_name
) {
  size_t qualified_length = strlen(qualified_name);
  size_t type_length = strlen(declared_type);
  size_t callee_length = strlen(callee_name);
  if (qualified_length < type_length + callee_length + 2) return false;
  size_t callee_start = qualified_length - callee_length;
  if (qualified_name[callee_start - 1] != '.' ||
      strcmp(qualified_name + callee_start, callee_name) != 0) return false;
  size_t type_start = callee_start - type_length - 1;
  if (strncmp(qualified_name + type_start, declared_type, type_length) != 0) return false;
  return type_start == 0 || qualified_name[type_start - 1] == '.';
}

static CallableResolution resolve_member_candidate_group(
  const CallableCandidate *candidates, int count, const char *declared_type,
  const char *callee_name
) {
  const CallableCandidate *match = NULL;
  int matched = 0;
  for (int candidate = 0; candidate < count; candidate++) {
    if (!member_candidate_matches(
          candidates[candidate].qualified_name, declared_type, callee_name)) continue;
    match = &candidates[candidate];
    matched++;
  }
  if (matched != 1) return (CallableResolution){0};
  return (CallableResolution){
    match->qualified_name, "receiver_declared_type_member", NULL, 1.0, count
  };
}

static CallableResolution callable_registry_resolve_member(
  const CallableRegistrySlot *slots, size_t capacity, const char *language,
  const char *callee_name, const char *declared_type
) {
  size_t index = callable_hash(language, callee_name, capacity - 1);
  while (slots[index].name) {
    if (strcmp(slots[index].language, language) == 0 &&
        strcmp(slots[index].name, callee_name) == 0) {
      CallableResolution implementation = resolve_member_candidate_group(
        slots[index].implementations, slots[index].implementation_count,
        declared_type, callee_name);
      if (implementation.qualified_name) return implementation;
      return resolve_member_candidate_group(
        slots[index].headers, slots[index].header_count, declared_type, callee_name);
    }
    index = (index + 1) & (capacity - 1);
  }
  return (CallableResolution){0};
}

static bool identifier_text(const char *text) {
  if (!text || !(isalpha((unsigned char)text[0]) || text[0] == '_')) return false;
  for (const char *cursor = text + 1; *cursor; cursor++) {
    if (!(isalnum((unsigned char)*cursor) || *cursor == '_')) return false;
  }
  return true;
}

static const char *receiver_declared_type(
  const WorkerBuffer *buffer, int file_index, const char *enclosing_qn,
  const char *receiver_text, int call_line
) {
  if (!identifier_text(receiver_text)) return NULL;
  char *receiver_qn = child_qualified_name(enclosing_qn, receiver_text);
  const char *declared_type = NULL;
  int matches = 0;
  for (size_t index = buffer->nodes.length; index > 0; index--) {
    const NodeObservation *item = &buffer->nodes.items[index - 1];
    if (item->file_index != file_index || item->start_line > call_line) continue;
    if (!item->declared_type || strcmp(item->qualified_name, receiver_qn) != 0) continue;
    declared_type = item->declared_type;
    matches++;
  }
  free(receiver_qn);
  return matches == 1 ? declared_type : NULL;
}

static void callable_qn_add(CallableQnSlot *slots, size_t capacity, const char *qualified_name) {
  size_t index = (size_t)hash_text_seed(qualified_name, UINT64_C(1469598103934665603)) &
    (capacity - 1);
  while (slots[index].qualified_name) {
    if (strcmp(slots[index].qualified_name, qualified_name) == 0) return;
    index = (index + 1) & (capacity - 1);
  }
  slots[index].qualified_name = strdup(qualified_name);
}

static bool callable_qn_contains(
  const CallableQnSlot *slots,
  size_t capacity,
  const char *qualified_name
) {
  size_t index = (size_t)hash_text_seed(qualified_name, UINT64_C(1469598103934665603)) &
    (capacity - 1);
  while (slots[index].qualified_name) {
    if (strcmp(slots[index].qualified_name, qualified_name) == 0) return true;
    index = (index + 1) & (capacity - 1);
  }
  return false;
}

static size_t resolved_call_hash(
  int file_id, const char *source, int line, int column, size_t mask
) {
  uint64_t hash = hash_text_seed(source, UINT64_C(1469598103934665603));
  hash ^= (uint64_t)(uint32_t)file_id * UINT64_C(11400714819323198485);
  hash ^= (uint64_t)(uint32_t)line * UINT64_C(14029467366897019727);
  hash ^= (uint64_t)(uint32_t)column * UINT64_C(1609587929392839161);
  return (size_t)hash & mask;
}

static bool resolved_call_contains(
  const ResolvedCallSlot *slots,
  size_t capacity,
  int file_id,
  const char *source,
  int line,
  int column
) {
  size_t index = resolved_call_hash(file_id, source, line, column, capacity - 1);
  while (slots[index].source_qualified_name) {
    if (slots[index].file_id == file_id && slots[index].start_line == line &&
        slots[index].start_column == column &&
        strcmp(slots[index].source_qualified_name, source) == 0) return true;
    index = (index + 1) & (capacity - 1);
  }
  return false;
}

static void resolved_call_add(
  ResolvedCallSlot *slots,
  size_t capacity,
  int file_id,
  const char *source,
  int line,
  int column
) {
  size_t index = resolved_call_hash(file_id, source, line, column, capacity - 1);
  while (slots[index].source_qualified_name) {
    if (slots[index].file_id == file_id && slots[index].start_line == line &&
        slots[index].start_column == column &&
        strcmp(slots[index].source_qualified_name, source) == 0) return;
    index = (index + 1) & (capacity - 1);
  }
  slots[index] = (ResolvedCallSlot){file_id, strdup(source), line, column};
}

#define PUSH(vector, value) do { \
  if ((vector)->length == (vector)->capacity) { \
    (vector)->capacity = (vector)->capacity ? (vector)->capacity * 2 : 128; \
    (vector)->items = checked_realloc((vector)->items, (vector)->capacity * sizeof(*(vector)->items)); \
  } \
  (vector)->items[(vector)->length++] = (value); \
} while (0)

static char *copy_range(const char *source, uint32_t start, uint32_t end) {
  if (end < start) end = start;
  size_t length = (size_t)(end - start);
  char *result = malloc(length + 1);
  if (!result) return NULL;
  memcpy(result, source + start, length);
  result[length] = '\0';
  return result;
}

static char *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return NULL; }
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) { fclose(file); return NULL; }
  char *source = malloc((size_t)size + 1);
  if (!source) { fclose(file); return NULL; }
  size_t read = fread(source, 1, (size_t)size, file);
  fclose(file);
  source[read] = '\0';
  *length = read;
  return source;
}

typedef struct {
  bool parent_active;
  bool active;
  bool any_taken;
} ConditionalFrame;

static bool macro_is_defined(char definitions[256][128], int count, const char *name) {
  for (int index = 0; index < count; index++) {
    if (strcmp(definitions[index], name) == 0) return true;
  }
  return false;
}

static void directive_name(const char *text, char output[128]) {
  while (*text == ' ' || *text == '\t') text++;
  size_t length = 0;
  while ((('a' <= *text && *text <= 'z') || ('A' <= *text && *text <= 'Z') ||
          ('0' <= *text && *text <= '9') || *text == '_') && length < 127) {
    output[length++] = *text++;
  }
  output[length] = '\0';
}

static bool evaluate_condition(const char *text, char definitions[256][128], int count) {
  while (*text == ' ' || *text == '\t') text++;
  bool negate = false;
  if (*text == '!') { negate = true; text++; while (*text == ' ' || *text == '\t') text++; }
  bool value = false;
  if (*text == '1' && !isalnum((unsigned char)text[1]) && text[1] != '_') value = true;
  else if (*text == '0' && !isalnum((unsigned char)text[1]) && text[1] != '_') value = false;
  else if (strncmp(text, "defined", 7) == 0) {
    text += 7;
    while (*text == ' ' || *text == '\t' || *text == '(') text++;
    char name[128]; directive_name(text, name);
    value = macro_is_defined(definitions, count, name);
  } else {
    char name[128]; directive_name(text, name);
    value = macro_is_defined(definitions, count, name);
  }
  return negate ? !value : value;
}

/* Select one deterministic preprocessor branch while preserving byte length and line numbers. */
static char *conditioned_source(const char *source, size_t length) {
  char *output = malloc(length + 1);
  if (!output) return NULL;
  memcpy(output, source, length + 1);
  ConditionalFrame frames[64];
  int depth = 0;
  bool active = true;
  char definitions[256][128];
  int definition_count = 0;
  bool continued_directive = false;
  size_t line_start = 0;
  while (line_start < length) {
    size_t line_end = line_start;
    while (line_end < length && source[line_end] != '\n') line_end++;
    const char *cursor = source + line_start;
    const char *limit = source + line_end;
    while (cursor < limit && (*cursor == ' ' || *cursor == '\t')) cursor++;
    bool directive = !continued_directive && cursor < limit && *cursor == '#';
    if (continued_directive) {
      for (size_t index = line_start; index < line_end; index++) output[index] = ' ';
    } else if (directive) {
      cursor++;
      while (cursor < limit && (*cursor == ' ' || *cursor == '\t')) cursor++;
      char command[32];
      size_t command_length = 0;
      while (cursor < limit && isalpha((unsigned char)*cursor) && command_length < 31) {
        command[command_length++] = *cursor++;
      }
      command[command_length] = '\0';
      while (cursor < limit && (*cursor == ' ' || *cursor == '\t')) cursor++;
      if ((strcmp(command, "ifdef") == 0 || strcmp(command, "ifndef") == 0 ||
           strcmp(command, "if") == 0) && depth < 64) {
        char name[128]; directive_name(cursor, name);
        bool condition = strcmp(command, "if") == 0
          ? evaluate_condition(cursor, definitions, definition_count)
          : macro_is_defined(definitions, definition_count, name);
        if (strcmp(command, "ifndef") == 0) condition = !condition;
        frames[depth++] = (ConditionalFrame){ .parent_active = active,
          .active = active && condition, .any_taken = condition };
        active = frames[depth - 1].active;
      } else if (strcmp(command, "elif") == 0 && depth > 0) {
        ConditionalFrame *frame = &frames[depth - 1];
        bool condition = evaluate_condition(cursor, definitions, definition_count);
        frame->active = frame->parent_active && !frame->any_taken && condition;
        frame->any_taken = frame->any_taken || condition;
        active = frame->active;
      } else if (strcmp(command, "else") == 0 && depth > 0) {
        ConditionalFrame *frame = &frames[depth - 1];
        frame->active = frame->parent_active && !frame->any_taken;
        frame->any_taken = true;
        active = frame->active;
      } else if (strcmp(command, "endif") == 0 && depth > 0) {
        ConditionalFrame frame = frames[--depth];
        active = frame.parent_active;
      } else if (strcmp(command, "define") == 0 && active && definition_count < 256) {
        char name[128]; directive_name(cursor, name);
        if (*name && !macro_is_defined(definitions, definition_count, name)) {
          strcpy(definitions[definition_count++], name);
        }
      } else if (strcmp(command, "undef") == 0 && active) {
        char name[128]; directive_name(cursor, name);
        for (int index = 0; index < definition_count; index++) {
          if (strcmp(definitions[index], name) == 0) {
            memcpy(definitions[index], definitions[--definition_count], 128);
            break;
          }
        }
      }
      for (size_t index = line_start; index < line_end; index++) output[index] = ' ';
    } else if (!active) {
      for (size_t index = line_start; index < line_end; index++) output[index] = ' ';
    }
    size_t tail = line_end;
    while (tail > line_start && (source[tail - 1] == ' ' || source[tail - 1] == '\t' || source[tail - 1] == '\r')) tail--;
    continued_directive = (directive || continued_directive) && tail > line_start && source[tail - 1] == '\\';
    line_start = line_end < length ? line_end + 1 : length;
  }
  return output;
}

static char *module_name(const char *rel_path) {
  char *result = strdup(rel_path);
  if (!result) return NULL;
  char *dot = strrchr(result, '.');
  if (dot) *dot = '\0';
  char *start = strncmp(result, "src/", 4) == 0 ? result + 4 : result;
  for (char *cursor = start; *cursor; cursor++) {
    if (*cursor == '/' || *cursor == '\\') *cursor = '.';
  }
  char *normalized = strdup(start);
  free(result);
  return normalized;
}

static bool is_header(const char *path) {
  const char *dot = strrchr(path, '.');
  if (!dot) return false;
  return strcmp(dot, ".h") == 0 || strcmp(dot, ".hh") == 0 ||
         strcmp(dot, ".hpp") == 0 || strcmp(dot, ".hxx") == 0;
}

static char *node_text(const char *source, TSNode node, size_t maximum);

static char *qualified_name(const char *module, const char *name, bool header) {
  size_t length = strlen(module) + strlen(name) + (header ? 12 : 2);
  char *result = malloc(length);
  if (!result) return NULL;
  snprintf(result, length, header ? "%s.__header.%s" : "%s.%s", module, name);
  return result;
}

static char *child_qualified_name(const char *parent, const char *name) {
  size_t length = strlen(parent) + strlen(name) + 2;
  char *result = malloc(length);
  if (!result) return NULL;
  snprintf(result, length, "%s.%s", parent, name);
  return result;
}

static char *root_qualified_name(const char *module, bool header) {
  if (!header) return strdup(module);
  return child_qualified_name(module, "__header");
}

static char *macro_qualified_name(const char *module, const char *name, bool header, int line) {
  char line_part[32];
  snprintf(line_part, sizeof(line_part), "L%d", line);
  char *root = root_qualified_name(module, header);
  char *macro_scope = child_qualified_name(root, "__macro");
  char *named = child_qualified_name(macro_scope, name);
  char *qualified = child_qualified_name(named, line_part);
  free(root);
  free(macro_scope);
  free(named);
  return qualified;
}

static bool is_cpp_container(const char *type) {
  return strcmp(type, "namespace_definition") == 0 || strcmp(type, "class_specifier") == 0 ||
    strcmp(type, "struct_specifier") == 0 || strcmp(type, "union_specifier") == 0;
}

static char *cpp_container_qualified_name(
  const char *source, TSNode node, const char *module, bool header, char **nearest_type_name
) {
  TSNode containers[32];
  size_t count = 0;
  TSNode current = ts_node_parent(node);
  while (!ts_node_is_null(current) && count < 32) {
    if (is_cpp_container(ts_node_type(current))) containers[count++] = current;
    current = ts_node_parent(current);
  }
  char *qualified = root_qualified_name(module, header);
  for (size_t index = count; index > 0; index--) {
    TSNode container = containers[index - 1];
    TSNode name_node = ts_node_child_by_field_name(container, "name", 4);
    if (ts_node_is_null(name_node)) continue;
    char *name = node_text(source, name_node, 256);
    char *next = child_qualified_name(qualified, name);
    if (nearest_type_name && strcmp(ts_node_type(container), "namespace_definition") != 0) {
      free(*nearest_type_name);
      *nearest_type_name = strdup(name);
    }
    free(name);
    free(qualified);
    qualified = next;
  }
  return qualified;
}

static void replace_cpp_separators(char *name) {
  char *read = name;
  char *write = name;
  while (*read) {
    if (read[0] == ':' && read[1] == ':') {
      *write++ = '.';
      read += 2;
    } else {
      *write++ = *read++;
    }
  }
  *write = '\0';
}

static TSNode definition_name_from_declarator(TSNode declarator) {
  if (ts_node_is_null(declarator)) return (TSNode){0};
  const char *type = ts_node_type(declarator);
  if (strcmp(type, "identifier") == 0 || strcmp(type, "field_identifier") == 0 ||
      strcmp(type, "destructor_name") == 0 || strcmp(type, "operator_name") == 0) return declarator;
  if (strcmp(type, "qualified_identifier") == 0) {
    TSNode name = ts_node_child_by_field_name(declarator, "name", 4);
    return ts_node_is_null(name) ? declarator : name;
  }
  TSNode inner = ts_node_child_by_field_name(declarator, "declarator", 10);
  if (!ts_node_is_null(inner)) return definition_name_from_declarator(inner);
  uint32_t count = ts_node_named_child_count(declarator);
  for (uint32_t index = 0; index < count; index++) {
    TSNode found = definition_name_from_declarator(ts_node_named_child(declarator, index));
    if (!ts_node_is_null(found)) return found;
  }
  return (TSNode){0};
}

static TSNode function_name_node(TSNode function_definition) {
  return definition_name_from_declarator(
    ts_node_child_by_field_name(function_definition, "declarator", 10)
  );
}

static char *cpp_function_qualified_name(
  const char *source, TSNode function_definition, const char *module, bool header,
  char **out_name, const char **out_kind
) {
  TSNode declarator = ts_node_child_by_field_name(function_definition, "declarator", 10);
  while (!ts_node_is_null(declarator) && strcmp(ts_node_type(declarator), "function_declarator") != 0) {
    declarator = ts_node_child_by_field_name(declarator, "declarator", 10);
  }
  TSNode target = ts_node_is_null(declarator)
    ? (TSNode){0}
    : ts_node_child_by_field_name(declarator, "declarator", 10);
  TSNode name_node = function_name_node(function_definition);
  if (ts_node_is_null(name_node)) return NULL;
  *out_name = node_text(source, name_node, 256);
  char *nearest_type = NULL;
  char *container = cpp_container_qualified_name(source, function_definition, module, header, &nearest_type);
  bool explicitly_qualified = !ts_node_is_null(target) && strcmp(ts_node_type(target), "qualified_identifier") == 0;
  char *relative = explicitly_qualified ? node_text(source, target, 1024) : strdup(*out_name);
  replace_cpp_separators(relative);
  char *qualified = child_qualified_name(container, relative);
  bool destructor = (*out_name)[0] == '~';
  bool constructor = nearest_type && strcmp(*out_name, nearest_type) == 0;
  if (!constructor && explicitly_qualified) {
    char *last_dot = strrchr(relative, '.');
    if (last_dot) {
      char *previous_dot = last_dot;
      while (previous_dot > relative && previous_dot[-1] != '.') previous_dot--;
      size_t owner_length = (size_t)(last_dot - previous_dot);
      constructor = strlen(*out_name) == owner_length &&
        strncmp(previous_dot, *out_name, owner_length) == 0;
    }
  }
  *out_kind = destructor ? "Destructor" : (constructor ? "Constructor" :
    (explicitly_qualified || nearest_type ? "Method" : "Function"));
  free(relative);
  free(container);
  free(nearest_type);
  return qualified;
}

static bool has_direct_text_child(TSNode node, const char *source, const char *wanted) {
  uint32_t count = ts_node_named_child_count(node);
  for (uint32_t index = 0; index < count; index++) {
    TSNode child = ts_node_named_child(node, index);
    char *text = node_text(source, child, 64);
    bool matches = text && strcmp(text, wanted) == 0;
    free(text);
    if (matches) return true;
  }
  return false;
}

static void emit_node(
  WorkerBuffer *buffer, int file_index, const char *kind, char *name, char *qualified,
  TSNode node, int is_exported, int is_entry_point
) {
  if (!name || !qualified) { free(name); free(qualified); return; }
  TSPoint start = ts_node_start_point(node);
  TSPoint end = ts_node_end_point(node);
  NodeObservation observation = {
    .file_index = file_index,
    .kind = strdup(kind),
    .name = name,
    .qualified_name = qualified,
    .declared_type = NULL,
    .start_line = (int)start.row + 1,
    .end_line = (int)end.row + 1,
    .is_exported = is_exported,
    .is_entry_point = is_entry_point,
  };
  PUSH(&buffer->nodes, observation);
}

static void emit_typed_node(
  WorkerBuffer *buffer, int file_index, const char *kind, char *name, char *qualified,
  char *declared_type, TSNode node, int is_exported, int is_entry_point
) {
  size_t before = buffer->nodes.length;
  emit_node(buffer, file_index, kind, name, qualified, node, is_exported, is_entry_point);
  if (buffer->nodes.length > before) buffer->nodes.items[buffer->nodes.length - 1].declared_type = declared_type;
  else free(declared_type);
}

static char *declared_type_text(const char *source, TSNode declaration) {
  TSNode type_node = ts_node_child_by_field_name(declaration, "type", 4);
  if (ts_node_is_null(type_node)) return NULL;
  char *declared_type = node_text(source, type_node, 512);
  if (declared_type) replace_cpp_separators(declared_type);
  return declared_type;
}

static TSNode find_named_identifier(TSNode node) {
  const char *type = ts_node_type(node);
  if (strcmp(type, "identifier") == 0 || strcmp(type, "field_identifier") == 0 ||
      strcmp(type, "type_identifier") == 0 || strcmp(type, "operator_name") == 0 ||
      strcmp(type, "destructor_name") == 0) {
    return node;
  }
  uint32_t count = ts_node_named_child_count(node);
  for (uint32_t index = 0; index < count; index++) {
    TSNode found = find_named_identifier(ts_node_named_child(node, index));
    if (!ts_node_is_null(found)) return found;
  }
  return (TSNode){0};
}

static char *node_text(const char *source, TSNode node, size_t maximum) {
  uint32_t start = ts_node_start_byte(node);
  uint32_t end = ts_node_end_byte(node);
  if ((size_t)(end - start) > maximum) end = start + (uint32_t)maximum;
  return copy_range(source, start, end);
}

static char *call_name(const char *source, TSNode function) {
  const char *type = ts_node_type(function);
  if (strcmp(type, "identifier") == 0 || strcmp(type, "field_identifier") == 0) {
    return node_text(source, function, 256);
  }
  if (strcmp(type, "field_expression") == 0) {
    TSNode field = ts_node_child_by_field_name(function, "field", 5);
    return ts_node_is_null(field) ? NULL : node_text(source, field, 256);
  }
  if (strcmp(type, "qualified_identifier") == 0 || strcmp(type, "scoped_identifier") == 0) {
    char *qualified = node_text(source, function, 256);
    replace_cpp_separators(qualified);
    return qualified;
  }
  if (strcmp(type, "template_function") == 0) {
    TSNode name = ts_node_child_by_field_name(function, "name", 4);
    return ts_node_is_null(name) ? NULL : node_text(source, name, 256);
  }
  TSNode identifier = find_named_identifier(function);
  return ts_node_is_null(identifier) ? NULL : node_text(source, identifier, 256);
}

static char *strip_include(char *value) {
  if (!value) return NULL;
  size_t length = strlen(value);
  if (length >= 2 && ((value[0] == '<' && value[length - 1] == '>') ||
                      (value[0] == '"' && value[length - 1] == '"'))) {
    memmove(value, value + 1, length - 2);
    value[length - 2] = '\0';
  }
  return value;
}

static void extract_type_members(
  WorkerBuffer *buffer, int file_index, const char *source, TSNode type_node, const char *type_qn
) {
  TSNode body = ts_node_child_by_field_name(type_node, "body", 4);
  if (ts_node_is_null(body)) return;
  uint32_t count = ts_node_named_child_count(body);
  for (uint32_t index = 0; index < count; index++) {
    TSNode member = ts_node_named_child(body, index);
    const char *member_type = ts_node_type(member);
    if (strcmp(member_type, "enumerator") == 0) {
      TSNode name_node = ts_node_child_by_field_name(member, "name", 4);
      if (ts_node_is_null(name_node)) name_node = find_named_identifier(member);
      if (!ts_node_is_null(name_node)) {
        char *name = node_text(source, name_node, 256);
        emit_node(buffer, file_index, "EnumMember", name, child_qualified_name(type_qn, name), member, 1, 0);
      }
      continue;
    }
    if (strcmp(member_type, "field_declaration") != 0) continue;
    uint32_t fields = ts_node_named_child_count(member);
    for (uint32_t field_index = 0; field_index < fields; field_index++) {
      TSNode declarator = ts_node_named_child(member, field_index);
      const char *declarator_type = ts_node_type(declarator);
      if (strstr(declarator_type, "type") || strcmp(declarator_type, "primitive_type") == 0) continue;
      if (strcmp(declarator_type, "function_declarator") == 0) continue;
      TSNode identifier = find_named_identifier(declarator);
      if (ts_node_is_null(identifier)) continue;
      char *name = node_text(source, identifier, 256);
      emit_typed_node(buffer, file_index, "Field", name, child_qualified_name(type_qn, name),
                      declared_type_text(source, member), member, 1, 0);
    }
  }
}

static TSNode declarator_identifier(TSNode declarator, bool *function_pointer) {
  if (ts_node_is_null(declarator)) return (TSNode){0};
  const char *type = ts_node_type(declarator);
  if (strcmp(type, "identifier") == 0) return declarator;
  if (strcmp(type, "function_declarator") == 0) {
    TSNode inner = ts_node_child_by_field_name(declarator, "declarator", 10);
    const char *inner_type = ts_node_is_null(inner) ? "" : ts_node_type(inner);
    if (strstr(inner_type, "parenthesized") || strstr(inner_type, "pointer")) {
      *function_pointer = true;
    } else {
      return (TSNode){0};
    }
    return declarator_identifier(inner, function_pointer);
  }
  TSNode inner = ts_node_child_by_field_name(declarator, "declarator", 10);
  if (!ts_node_is_null(inner)) return declarator_identifier(inner, function_pointer);
  uint32_t count = ts_node_named_child_count(declarator);
  for (uint32_t index = 0; index < count; index++) {
    TSNode found = declarator_identifier(ts_node_named_child(declarator, index), function_pointer);
    if (!ts_node_is_null(found)) return found;
  }
  return (TSNode){0};
}

static TSNode function_declarator_in_chain(TSNode declarator) {
  for (int depth = 0; depth < 24 && !ts_node_is_null(declarator); depth++) {
    if (strcmp(ts_node_type(declarator), "function_declarator") == 0) return declarator;
    declarator = ts_node_child_by_field_name(declarator, "declarator", 10);
  }
  return (TSNode){0};
}

static void extract_module_variables(
  WorkerBuffer *buffer, int file_index, const char *source, TSNode declaration,
  const char *module, bool header
) {
  TSNode parent = ts_node_parent(declaration);
  if (ts_node_is_null(parent) || strcmp(ts_node_type(parent), "translation_unit") != 0) return;
  bool exported = !has_direct_text_child(declaration, source, "static");
  uint32_t count = ts_node_named_child_count(declaration);
  for (uint32_t index = 0; index < count; index++) {
    TSNode child = ts_node_named_child(declaration, index);
    const char *type = ts_node_type(child);
    if (strcmp(type, "primitive_type") == 0 || strcmp(type, "type_identifier") == 0 ||
        strstr(type, "specifier")) continue;
    bool function_pointer = false;
    TSNode identifier = declarator_identifier(child, &function_pointer);
    if (ts_node_is_null(identifier)) continue;
    char *name = node_text(source, identifier, 256);
    emit_typed_node(buffer, file_index, function_pointer ? "FunctionPointer" : "Variable", name,
                    qualified_name(module, name, header), declared_type_text(source, declaration),
                    declaration, exported ? 1 : 0, 0);
  }
}

static void extract_scoped_declaration_values(
  WorkerBuffer *buffer,
  int file_index,
  const char *source,
  TSNode declaration,
  const char *scope
) {
  uint32_t count = ts_node_named_child_count(declaration);
  for (uint32_t index = 0; index < count; index++) {
    TSNode child = ts_node_named_child(declaration, index);
    const char *type = ts_node_type(child);
    if (strcmp(type, "primitive_type") == 0 || strcmp(type, "type_identifier") == 0 ||
        strstr(type, "specifier")) continue;
    bool function_pointer = false;
    TSNode identifier = declarator_identifier(child, &function_pointer);
    if (ts_node_is_null(identifier)) continue;
    char *name = node_text(source, identifier, 256);
    emit_typed_node(buffer, file_index, function_pointer ? "FunctionPointer" : "Variable", name,
                    child_qualified_name(scope, name), declared_type_text(source, declaration),
                    declaration, 0, 0);
    if (strcmp(type, "init_declarator") == 0) {
      UsageObservation observation = {
        .file_index = file_index,
        .enclosing_qn = strdup(scope),
        .referenced_name = strdup(name),
        .start_line = (int)ts_node_start_point(identifier).row + 1,
        .start_column = (int)ts_node_start_point(identifier).column,
        .is_write = 1,
      };
      PUSH(&buffer->usages, observation);
    }
  }
}

static void extract_function_parameters_recursive(
  WorkerBuffer *buffer,
  int file_index,
  const char *source,
  TSNode node,
  const char *scope
) {
  if (strcmp(ts_node_type(node), "parameter_declaration") == 0) {
    TSNode declarator = ts_node_child_by_field_name(node, "declarator", 10);
    bool function_pointer = false;
    TSNode identifier = declarator_identifier(declarator, &function_pointer);
    if (!ts_node_is_null(identifier)) {
      char *name = node_text(source, identifier, 256);
      emit_typed_node(buffer, file_index, function_pointer ? "FunctionPointer" : "Variable", name,
                      child_qualified_name(scope, name), declared_type_text(source, node),
                      node, 0, 0);
    }
    return;
  }
  uint32_t count = ts_node_named_child_count(node);
  for (uint32_t index = 0; index < count; index++) {
    extract_function_parameters_recursive(buffer, file_index, source,
      ts_node_named_child(node, index), scope);
  }
}

static bool node_contains(TSNode container, TSNode child) {
  return ts_node_start_byte(container) <= ts_node_start_byte(child) &&
    ts_node_end_byte(container) >= ts_node_end_byte(child);
}

static bool is_declaration_identifier(TSNode identifier) {
  TSNode current = identifier;
  for (;;) {
    TSNode parent = ts_node_parent(current);
    if (ts_node_is_null(parent)) return false;
    const char *type = ts_node_type(parent);
    if (strcmp(type, "function_declarator") == 0 || strcmp(type, "parameter_declaration") == 0 ||
        strcmp(type, "init_declarator") == 0 || strcmp(type, "field_declaration") == 0 ||
        strcmp(type, "type_definition") == 0) {
      TSNode declarator = ts_node_child_by_field_name(parent, "declarator", 10);
      if (!ts_node_is_null(declarator) && node_contains(declarator, identifier)) return true;
    }
    if (strcmp(type, "function_definition") == 0 || strcmp(type, "declaration") == 0 ||
        strcmp(type, "compound_statement") == 0) return false;
    current = parent;
  }
}

static bool is_call_target_identifier(TSNode identifier) {
  TSNode current = identifier;
  for (;;) {
    TSNode parent = ts_node_parent(current);
    if (ts_node_is_null(parent)) return false;
    if (strcmp(ts_node_type(parent), "call_expression") == 0) {
      TSNode function = ts_node_child_by_field_name(parent, "function", 8);
      return !ts_node_is_null(function) && node_contains(function, identifier);
    }
    if (strcmp(ts_node_type(parent), "expression_statement") == 0 ||
        strcmp(ts_node_type(parent), "compound_statement") == 0) return false;
    current = parent;
  }
}

static bool is_write_identifier(TSNode identifier) {
  TSNode current = identifier;
  for (;;) {
    TSNode parent = ts_node_parent(current);
    if (ts_node_is_null(parent)) return false;
    const char *type = ts_node_type(parent);
    if (strcmp(type, "assignment_expression") == 0) {
      TSNode left = ts_node_child_by_field_name(parent, "left", 4);
      return !ts_node_is_null(left) && node_contains(left, identifier);
    }
    if (strcmp(type, "update_expression") == 0) return true;
    if (strcmp(type, "statement") == 0 || strstr(type, "declaration") ||
        strcmp(type, "compound_statement") == 0) return false;
    current = parent;
  }
}

static bool usage_already_seen(
  WorkerBuffer *buffer, int file_index, const char *scope, const char *name, int is_write
) {
  for (size_t index = buffer->usages.length; index > 0; index--) {
    UsageObservation *item = &buffer->usages.items[index - 1];
    if (item->file_index != file_index) break;
    if (item->is_write == is_write && strcmp(item->enclosing_qn, scope) == 0 &&
        strcmp(item->referenced_name, name) == 0) return true;
  }
  return false;
}

static bool macro_call_keyword(const char *name) {
  static const char *keywords[] = {
    "defined", "sizeof", "typeof", "_Alignof", "if", "for", "while", "switch", NULL,
  };
  for (int index = 0; keywords[index]; index++) {
    if (strcmp(name, keywords[index]) == 0) return true;
  }
  return false;
}

static void extract_macro_call_aliases(
  WorkerBuffer *buffer,
  int file_index,
  const char *source,
  TSNode macro_node,
  const char *macro_name
) {
  TSNode value = ts_node_child_by_field_name(macro_node, "value", 5);
  if (ts_node_is_null(value)) return;
  char *replacement = node_text(source, value, 8192);
  if (!replacement) return;
  size_t length = strlen(replacement);
  for (size_t cursor = 0; cursor < length;) {
    if (!(isalpha((unsigned char)replacement[cursor]) || replacement[cursor] == '_')) {
      cursor++;
      continue;
    }
    size_t start = cursor++;
    while (cursor < length &&
           (isalnum((unsigned char)replacement[cursor]) || replacement[cursor] == '_')) cursor++;
    size_t end = cursor;
    while (cursor < length && isspace((unsigned char)replacement[cursor])) cursor++;
    if (cursor >= length || replacement[cursor] != '(') continue;
    char *target_name = copy_range(replacement, (uint32_t)start, (uint32_t)end);
    if (!target_name) continue;
    if (strcmp(target_name, macro_name) == 0 || macro_call_keyword(target_name)) {
      free(target_name);
      continue;
    }
    PUSH(&buffer->macro_aliases, ((MacroAliasObservation){
      .file_index = file_index,
      .macro_name = strdup(macro_name),
      .target_name = target_name,
      .start_line = (int)ts_node_start_point(macro_node).row + 1,
    }));
  }
  free(replacement);
}

static void walk_tree(
  WorkerBuffer *buffer,
  int file_index,
  const char *source,
  TSNode node,
  const char *module,
  bool header,
  bool cpp,
  const char *enclosing_qn
) {
  const char *type = ts_node_type(node);
  char *owned_scope = NULL;
  const char *scope = enclosing_qn;

  if (strcmp(type, "function_definition") == 0) {
    TSNode identifier = function_name_node(node);
    if (!ts_node_is_null(identifier)) {
      char *name = NULL;
      const char *kind = "Function";
      owned_scope = cpp
        ? cpp_function_qualified_name(source, node, module, header, &name, &kind)
        : qualified_name(module, (name = node_text(source, identifier, 256)), header);
      bool is_main = strcmp(name, "main") == 0;
      emit_node(buffer, file_index, kind, name, strdup(owned_scope), node,
                has_direct_text_child(node, source, "static") ? 0 : 1, is_main ? 1 : 0);
      TSNode declarator = ts_node_child_by_field_name(node, "declarator", 10);
      extract_function_parameters_recursive(buffer, file_index, source, declarator, owned_scope);
      scope = owned_scope;
    }
  } else if (cpp && strcmp(type, "namespace_definition") == 0) {
    TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
    if (!ts_node_is_null(name_node)) {
      char *name = node_text(source, name_node, 256);
      char *container = cpp_container_qualified_name(source, node, module, header, NULL);
      emit_node(buffer, file_index, "Namespace", name, child_qualified_name(container, name), node, 1, 0);
      free(container);
    }
  } else if (strcmp(type, "class_specifier") == 0 || strcmp(type, "struct_specifier") == 0 ||
             strcmp(type, "union_specifier") == 0 ||
             strcmp(type, "enum_specifier") == 0) {
    TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
    if (!ts_node_is_null(name_node)) {
      char *name = node_text(source, name_node, 256);
      char *qn = NULL;
      if (cpp) {
        char *container = cpp_container_qualified_name(source, node, module, header, NULL);
        qn = child_qualified_name(container, name);
        free(container);
      } else {
        char *tag_parent = qualified_name(module, "__tag", header);
        qn = child_qualified_name(tag_parent, name);
        free(tag_parent);
      }
      const char *kind = strcmp(type, "class_specifier") == 0 ? "Class" :
        (strcmp(type, "struct_specifier") == 0 ? "Struct" :
        (strcmp(type, "union_specifier") == 0 ? "Union" : "Enum"));
      emit_node(buffer, file_index, kind, name, strdup(qn), node, 1, 0);
      extract_type_members(buffer, file_index, source, node, qn);
      free(qn);
    }
  } else if (strcmp(type, "type_definition") == 0) {
    TSNode declarator = ts_node_child_by_field_name(node, "declarator", 10);
    TSNode identifier = find_named_identifier(declarator);
    if (!ts_node_is_null(identifier)) {
      char *name = node_text(source, identifier, 256);
      emit_node(buffer, file_index, "TypeAlias", name, qualified_name(module, name, header), node, 1, 0);
    }
  } else if (strcmp(type, "declaration") == 0) {
    if (header) {
      uint32_t count = ts_node_named_child_count(node);
      for (uint32_t index = 0; index < count; index++) {
        TSNode child = ts_node_named_child(node, index);
        TSNode function_declarator = function_declarator_in_chain(child);
        if (ts_node_is_null(function_declarator)) continue;
        TSNode identifier = ts_node_child_by_field_name(function_declarator, "declarator", 10);
        if (ts_node_is_null(identifier) || strcmp(ts_node_type(identifier), "identifier") != 0) continue;
        char *name = node_text(source, identifier, 256);
        emit_node(buffer, file_index, "Function", name, qualified_name(module, name, true), node, 1, 0);
      }
    }
    extract_module_variables(buffer, file_index, source, node, module, header);
    TSNode parent = ts_node_parent(node);
    if (scope && !ts_node_is_null(parent) && strcmp(ts_node_type(parent), "translation_unit") != 0) {
      extract_scoped_declaration_values(buffer, file_index, source, node, scope);
    }
  } else if (strcmp(type, "preproc_def") == 0 || strcmp(type, "preproc_function_def") == 0) {
    TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
    if (!ts_node_is_null(name_node)) {
      char *name = node_text(source, name_node, 256);
      int line = (int)ts_node_start_point(node).row + 1;
      emit_node(buffer, file_index, "Macro", name,
                macro_qualified_name(module, name, header, line), node, 1, 0);
      extract_macro_call_aliases(buffer, file_index, source, node, name);
    }
  } else if (strcmp(type, "call_expression") == 0 && scope) {
    TSNode function = ts_node_child_by_field_name(node, "function", 8);
    const char *function_type = ts_node_type(function);
    const char *dispatch_kind = "direct";
    char *receiver_text = NULL;
    if (strcmp(function_type, "field_expression") == 0) {
      dispatch_kind = "member";
      TSNode receiver = ts_node_child_by_field_name(function, "argument", 8);
      if (!ts_node_is_null(receiver)) receiver_text = node_text(source, receiver, 256);
    } else if (strcmp(function_type, "qualified_identifier") == 0 ||
               strcmp(function_type, "scoped_identifier") == 0) {
      dispatch_kind = "qualified";
    } else if (strcmp(function_type, "template_function") == 0) {
      dispatch_kind = "template";
    }
    char *callee = call_name(source, function);
    if (callee && *callee) {
      CallObservation observation = {
        .file_index = file_index,
        .enclosing_qn = strdup(scope),
        .callee_name = callee,
        .dispatch_kind = strdup(dispatch_kind),
        .receiver_text = receiver_text,
        .start_line = (int)ts_node_start_point(node).row + 1,
        .start_column = (int)ts_node_start_point(node).column,
      };
      PUSH(&buffer->calls, observation);
    } else {
      free(callee);
      free(receiver_text);
    }
  } else if (strcmp(type, "preproc_include") == 0) {
    TSNode path_node = ts_node_child_by_field_name(node, "path", 4);
    if (!ts_node_is_null(path_node)) {
      char *raw_path = node_text(source, path_node, 1024);
      bool is_local = raw_path && raw_path[0] == '"';
      char *include_path = strip_include(raw_path);
      if (include_path && *include_path) {
        const char *slash = strrchr(include_path, '/');
        ImportObservation observation = {
          .file_index = file_index,
          .local_name = strdup(slash ? slash + 1 : include_path),
          .module_path = include_path,
          .is_local = is_local ? 1 : 0,
          .start_line = (int)ts_node_start_point(node).row + 1,
        };
        PUSH(&buffer->imports, observation);
      } else {
        free(include_path);
      }
    }
  } else if (strcmp(type, "identifier") == 0 && scope &&
             !is_declaration_identifier(node) && !is_call_target_identifier(node)) {
    char *name = node_text(source, node, 256);
    int is_write = is_write_identifier(node) ? 1 : 0;
    int start_line = (int)ts_node_start_point(node).row + 1;
    int start_column = (int)ts_node_start_point(node).column;
    if (name && strlen(name) >= 2 &&
        !usage_already_seen(buffer, file_index, scope, name, is_write)) {
      UsageObservation observation = {
        .file_index = file_index,
        .enclosing_qn = strdup(scope),
        .referenced_name = name,
        .start_line = start_line,
        .start_column = start_column,
        .is_write = is_write,
      };
      PUSH(&buffer->usages, observation);
    } else {
      free(name);
    }
  }

  uint32_t count = ts_node_named_child_count(node);
  for (uint32_t index = 0; index < count; index++) {
    walk_tree(buffer, file_index, source, ts_node_named_child(node, index), module, header, cpp, scope);
  }
  free(owned_scope);
}

static bool source_line_contains_name(const char *source, int line, const char *name) {
  if (!source || line < 1 || !name || !*name) return false;
  const char *start = source;
  for (int current = 1; current < line && *start; start++) if (*start == '\n') current++;
  const char *end = strchr(start, '\n');
  if (!end) end = start + strlen(start);
  size_t length = strlen(name);
  for (const char *cursor = start; cursor + length <= end; cursor++) {
    if (strncmp(cursor, name, length) != 0) continue;
    bool left = cursor == start || !(isalnum((unsigned char)cursor[-1]) || cursor[-1] == '_');
    bool right = cursor + length == end ||
      !(isalnum((unsigned char)cursor[length]) || cursor[length] == '_');
    if (left && right) return true;
  }
  return false;
}

static bool node_observation_exists(
  WorkerBuffer *buffer, int file_index, const char *name, int start_line
) {
  for (size_t index = buffer->nodes.length; index > 0; index--) {
    NodeObservation *item = &buffer->nodes.items[index - 1];
    if (item->file_index != file_index) break;
    if (item->start_line == start_line && strcmp(item->name, name) == 0) return true;
  }
  return false;
}

static bool qualified_observation_exists(
  WorkerBuffer *buffer, int file_index, const char *qualified
) {
  for (size_t index = buffer->nodes.length; index > 0; index--) {
    NodeObservation *item = &buffer->nodes.items[index - 1];
    if (item->file_index != file_index) break;
    if (strcmp(item->qualified_name, qualified) == 0) return true;
  }
  return false;
}

static char *variant_qualified_name(char *base, int line) {
  char suffix[48];
  snprintf(suffix, sizeof(suffix), "__variant.L%d", line);
  char *qualified = child_qualified_name(base, suffix);
  free(base);
  return qualified;
}

static void walk_recovered_definitions(
  WorkerBuffer *buffer, int file_index, const char *raw_source, const char *parsed_source,
  TSNode node, const char *module, bool header, bool cpp
) {
  if (strcmp(ts_node_type(node), "function_definition") == 0) {
    TSNode identifier = function_name_node(node);
    if (!ts_node_is_null(identifier)) {
      char *name = NULL;
      const char *kind = "Function";
      char *qualified = cpp
        ? cpp_function_qualified_name(parsed_source, node, module, header, &name, &kind)
        : qualified_name(module, (name = node_text(parsed_source, identifier, 256)), header);
      int line = (int)ts_node_start_point(node).row + 1;
      if (source_line_contains_name(raw_source, line, name) &&
          !node_observation_exists(buffer, file_index, name, line)) {
        if (qualified_observation_exists(buffer, file_index, qualified)) {
          qualified = variant_qualified_name(qualified, line);
        }
        bool is_main = strcmp(name, "main") == 0;
        emit_node(buffer, file_index, kind, name, qualified, node,
                  has_direct_text_child(node, parsed_source, "static") ? 0 : 1,
                  is_main ? 1 : 0);
        name = NULL;
        qualified = NULL;
      }
      free(name);
      free(qualified);
    }
  }
  uint32_t count = ts_node_named_child_count(node);
  for (uint32_t index = 0; index < count; index++) {
    walk_recovered_definitions(buffer, file_index, raw_source, parsed_source,
      ts_node_named_child(node, index), module, header, cpp);
  }
}

static void process_file(WorkerBuffer *buffer, FileTask *task, int file_index) {
  size_t length = 0;
  char *source = read_file(task->abs_path, &length);
  if (!source) { buffer->errors++; return; }
  task->size = (long)length;
  sha256_bytes((const uint8_t *)source, length, task->sha256);

  TSParser *parser = ts_parser_new();
  const TSLanguage *language = strcmp(task->language, "cpp") == 0
    ? tree_sitter_cpp()
    : tree_sitter_c();
  if (!parser || !ts_parser_set_language(parser, language)) {
    free(source);
    if (parser) ts_parser_delete(parser);
    buffer->errors++;
    return;
  }
  TSTree *tree = ts_parser_parse_string(parser, NULL, source, (uint32_t)length);
  if (!tree) {
    ts_parser_delete(parser);
    free(source);
    buffer->errors++;
    return;
  }

  char *module = module_name(task->rel_path);
  size_t global_length = strlen(module) + 9;
  char *global_scope = malloc(global_length);
  snprintf(global_scope, global_length, "%s._global", module);
  walk_tree(buffer, file_index, source, ts_tree_root_node(tree), module, is_header(task->rel_path),
            strcmp(task->language, "cpp") == 0, global_scope);
  if (ts_node_has_error(ts_tree_root_node(tree))) {
    char *conditioned = conditioned_source(source, length);
    if (conditioned) {
      TSTree *recovered_tree = ts_parser_parse_string(parser, NULL, conditioned, (uint32_t)length);
      if (recovered_tree) {
        walk_recovered_definitions(buffer, file_index, source, conditioned,
          ts_tree_root_node(recovered_tree), module, is_header(task->rel_path),
          strcmp(task->language, "cpp") == 0);
        ts_tree_delete(recovered_tree);
      }
      free(conditioned);
    }
  }
  free(global_scope);
  free(module);
  ts_tree_delete(tree);
  ts_parser_delete(parser);
  free(source);
}

static void *worker_main(void *opaque) {
  WorkContext *context = opaque;
  int worker_index = atomic_fetch_add_explicit(&context->next_worker, 1, memory_order_relaxed);
  WorkerBuffer *buffer = &context->buffers[worker_index];
  for (;;) {
    int file_index = atomic_fetch_add_explicit(&context->next_file, 1, memory_order_relaxed);
    if (file_index >= context->file_count) break;
    process_file(buffer, &context->files[file_index], file_index);
  }
  return NULL;
}

static int load_manifest(const char *path, FileTask **out_files) {
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  FileTask *files = NULL;
  size_t count = 0, capacity = 0;
  char *line = NULL;
  size_t line_capacity = 0;
  while (getline(&line, &line_capacity, file) >= 0) {
    char *newline = strchr(line, '\n');
    if (newline) *newline = '\0';
    char *language = strtok(line, "\t");
    char *rel_path = strtok(NULL, "\t");
    char *abs_path = strtok(NULL, "\t");
    if (!language || !rel_path || !abs_path) continue;
    if (count == capacity) {
      capacity = capacity ? capacity * 2 : 256;
      files = checked_realloc(files, capacity * sizeof(*files));
    }
    struct stat info = {0};
    stat(abs_path, &info);
    files[count++] = (FileTask){
      .language = strdup(language),
      .rel_path = strdup(rel_path),
      .abs_path = strdup(abs_path),
      .size = info.st_size,
    };
  }
  free(line);
  fclose(file);
  *out_files = files;
  return (int)count;
}

static void sql_or_die(sqlite3 *db, const char *sql) {
  char *error = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &error) != SQLITE_OK) {
    fprintf(stderr, "native core SQLite error: %s\n", error ? error : "unknown");
    sqlite3_free(error);
    exit(3);
  }
}

static void bind_text(sqlite3_stmt *stmt, int index, const char *value) {
  sqlite3_bind_text(stmt, index, value ? value : "", -1, SQLITE_TRANSIENT);
}

static char *resolve_relative_include(const char *caller_path, const char *include_path) {
  if (!caller_path || !include_path || include_path[0] == '/') return NULL;
  const char *slash = strrchr(caller_path, '/');
  size_t directory_length = slash ? (size_t)(slash - caller_path + 1) : 0;
  size_t combined_length = directory_length + strlen(include_path);
  char *combined = malloc(combined_length + 1);
  if (!combined) return NULL;
  memcpy(combined, caller_path, directory_length);
  strcpy(combined + directory_length, include_path);
  char *segments[256];
  int count = 0;
  char *save = NULL;
  for (char *part = strtok_r(combined, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (strcmp(part, ".") == 0 || !*part) continue;
    if (strcmp(part, "..") == 0) {
      if (count == 0) { free(combined); return NULL; }
      count--;
    } else if (count < 256) {
      segments[count++] = part;
    } else {
      free(combined);
      return NULL;
    }
  }
  size_t result_length = 1;
  for (int index = 0; index < count; index++) result_length += strlen(segments[index]) + 1;
  char *result = malloc(result_length);
  if (!result) { free(combined); return NULL; }
  result[0] = '\0';
  for (int index = 0; index < count; index++) {
    if (index) strcat(result, "/");
    strcat(result, segments[index]);
  }
  free(combined);
  return result;
}

static void resolve_staging_edges(sqlite3 *db) {
  sql_or_die(db,
    "INSERT OR IGNORE INTO native_edges(file_id,source_qualified_name,target_qualified_name,type,start_line,start_column,confidence,strategy,evidence_json) "
    "SELECT c.file_id,c.enclosing_qualified_name,t.qualified_name,'CALLS',c.start_line,c.start_column,1.0, "
    "'same_file_direct_unique',json_object('dispatch',c.dispatch_kind,'callee',c.callee_name) "
    "FROM native_calls c "
    "JOIN native_nodes s ON s.file_id=c.file_id AND s.qualified_name=c.enclosing_qualified_name "
    "JOIN native_nodes t ON t.file_id=c.file_id AND t.name=c.callee_name "
    "AND t.kind IN ('Function','Method','Constructor','Destructor') "
    "WHERE c.dispatch_kind='direct' "
    "AND (SELECT COUNT(*) FROM native_nodes x WHERE x.file_id=c.file_id AND x.name=c.callee_name "
    "AND x.kind IN ('Function','Method','Constructor','Destructor'))=1;"
  );
  sql_or_die(db,
    "INSERT OR IGNORE INTO native_edges(file_id,source_qualified_name,target_qualified_name,type,start_line,start_column,confidence,strategy,evidence_json) "
    "SELECT u.file_id,u.enclosing_qualified_name,t.qualified_name, "
    "CASE WHEN u.is_write=1 THEN 'WRITES' ELSE 'READS' END,u.start_line,u.start_column,1.0, "
    "'lexical_scope_value',json_object('reference',u.referenced_name,'is_write',u.is_write) "
    "FROM native_usages u "
    "JOIN native_nodes source ON source.file_id=u.file_id AND source.qualified_name=u.enclosing_qualified_name "
    "JOIN native_nodes t ON t.file_id=u.file_id "
    "AND t.qualified_name=u.enclosing_qualified_name||'.'||u.referenced_name "
    "AND t.kind IN ('Variable','FunctionPointer');"
  );
  sql_or_die(db,
    "INSERT OR IGNORE INTO native_edges(file_id,source_qualified_name,target_qualified_name,type,start_line,start_column,confidence,strategy,evidence_json) "
    "SELECT c.file_id,c.enclosing_qualified_name,impl.qualified_name,'CALLS',c.start_line,c.start_column,0.98, "
    "'include_declaration_unique_implementation', "
    "json_object('dispatch',c.dispatch_kind,'callee',c.callee_name,'include',i.module_path, "
    "'resolved_include',i.resolved_rel_path,'declaration',decl.qualified_name) "
    "FROM native_calls c "
    "JOIN native_nodes source ON source.file_id=c.file_id AND source.qualified_name=c.enclosing_qualified_name "
    "JOIN native_files source_file ON source_file.id=c.file_id "
    "JOIN native_imports i ON i.file_id=c.file_id AND i.resolved_rel_path IS NOT NULL "
    "JOIN native_files header_file ON header_file.rel_path=i.resolved_rel_path "
    "JOIN native_nodes decl ON decl.file_id=header_file.id AND decl.name=c.callee_name "
    "AND decl.kind IN ('Function','Method') "
    "JOIN native_nodes impl ON impl.name=c.callee_name AND impl.is_exported=1 "
    "AND impl.kind IN ('Function','Method','Constructor','Destructor') "
    "JOIN native_files impl_file ON impl_file.id=impl.file_id AND impl_file.language=source_file.language "
    "AND (impl_file.rel_path LIKE '%.c' OR impl_file.rel_path LIKE '%.cc' OR "
    "impl_file.rel_path LIKE '%.cpp' OR impl_file.rel_path LIKE '%.cxx') "
    "WHERE c.dispatch_kind='direct' "
    "AND NOT EXISTS (SELECT 1 FROM native_edges e WHERE e.file_id=c.file_id "
    "AND e.source_qualified_name=c.enclosing_qualified_name AND e.start_line=c.start_line "
    "AND e.start_column=c.start_column AND e.type='CALLS') "
    "AND (SELECT COUNT(*) FROM native_nodes hd WHERE hd.file_id=header_file.id "
    "AND hd.name=c.callee_name AND hd.kind IN ('Function','Method'))=1 "
    "AND (SELECT COUNT(*) FROM native_nodes candidate "
    "JOIN native_files candidate_file ON candidate_file.id=candidate.file_id "
    "WHERE candidate.name=c.callee_name AND candidate.is_exported=1 "
    "AND candidate.kind IN ('Function','Method','Constructor','Destructor') "
    "AND candidate_file.language=source_file.language "
    "AND (candidate_file.rel_path LIKE '%.c' OR candidate_file.rel_path LIKE '%.cc' OR "
    "candidate_file.rel_path LIKE '%.cpp' OR candidate_file.rel_path LIKE '%.cxx'))=1;"
  );
  sql_or_die(db,
    "INSERT OR IGNORE INTO native_edges(file_id,source_qualified_name,target_qualified_name,type,start_line,start_column,confidence,strategy,evidence_json) "
    "SELECT u.file_id,u.enclosing_qualified_name,t.qualified_name, "
    "CASE WHEN u.is_write=1 THEN 'WRITES' ELSE 'READS' END,u.start_line,u.start_column,1.0, "
    "'same_file_value_unique',json_object('reference',u.referenced_name,'is_write',u.is_write) "
    "FROM native_usages u "
    "JOIN native_nodes source ON source.file_id=u.file_id AND source.qualified_name=u.enclosing_qualified_name "
    "JOIN native_nodes t ON t.file_id=u.file_id AND t.name=u.referenced_name "
    "AND t.kind IN ('Variable','FunctionPointer','Macro') "
    "WHERE NOT EXISTS (SELECT 1 FROM native_edges edge WHERE edge.file_id=u.file_id "
    "AND edge.source_qualified_name=u.enclosing_qualified_name AND edge.start_line=u.start_line "
    "AND edge.start_column=u.start_column "
    "AND edge.type=CASE WHEN u.is_write=1 THEN 'WRITES' ELSE 'READS' END) "
    "AND (SELECT COUNT(*) FROM native_nodes candidate WHERE candidate.file_id=u.file_id "
    "AND candidate.name=u.referenced_name AND candidate.kind IN ('Variable','FunctionPointer','Macro'))=1;"
  );
}

static void resolve_global_unique_calls(
  sqlite3 *db,
  FileTask *files,
  int file_count,
  WorkerBuffer *buffers,
  int worker_count
) {
  size_t node_count = 0;
  size_t call_count = 0;
  for (int worker = 0; worker < worker_count; worker++) {
    node_count += buffers[worker].nodes.length;
    call_count += buffers[worker].calls.length;
  }

  size_t registry_capacity = hash_capacity(node_count ? node_count : 1);
  CallableRegistrySlot *registry = calloc(registry_capacity, sizeof(*registry));
  MacroAliasSlot *macro_aliases = calloc(registry_capacity, sizeof(*macro_aliases));
  CallableQnSlot *callable_qns = calloc(registry_capacity, sizeof(*callable_qns));
  size_t resolved_capacity = hash_capacity(call_count ? call_count : 1);
  ResolvedCallSlot *resolved = calloc(resolved_capacity, sizeof(*resolved));
  StringVector *imports_by_file = calloc((size_t)file_count, sizeof(*imports_by_file));
  if (!registry || !macro_aliases || !callable_qns || !resolved || !imports_by_file) {
    fputs("native core: out of memory while resolving calls\n", stderr);
    exit(2);
  }

  sqlite3_stmt *callables = NULL;
  sqlite3_prepare_v2(db,
    "SELECT file.language,node.name,node.qualified_name,file.rel_path FROM native_nodes node "
    "JOIN native_files file ON file.id=node.file_id "
    "WHERE node.kind IN ('Function','Method','Constructor','Destructor')",
    -1, &callables, NULL);
  while (sqlite3_step(callables) == SQLITE_ROW) {
    const char *qualified_name = (const char *)sqlite3_column_text(callables, 2);
    callable_registry_add(registry, registry_capacity,
      (const char *)sqlite3_column_text(callables, 0),
      (const char *)sqlite3_column_text(callables, 1),
      qualified_name, (const char *)sqlite3_column_text(callables, 3),
      strstr(qualified_name, ".__header.") != NULL);
    callable_qn_add(callable_qns, registry_capacity, qualified_name);
  }
  sqlite3_finalize(callables);

  for (int worker = 0; worker < worker_count; worker++) {
    WorkerBuffer *buffer = &buffers[worker];
    for (size_t index = 0; index < buffer->macro_aliases.length; index++) {
      MacroAliasObservation *alias = &buffer->macro_aliases.items[index];
      macro_alias_add(macro_aliases, registry_capacity, files[alias->file_index].language,
                      alias->macro_name, alias->target_name);
    }
    for (size_t index = 0; index < buffer->imports.length; index++) {
      ImportObservation *imported = &buffer->imports.items[index];
      if (imported->is_local) {
        char *resolved_path = resolve_relative_include(files[imported->file_index].rel_path,
                                                       imported->module_path);
        if (resolved_path) PUSH(&imports_by_file[imported->file_index], resolved_path);
      }
    }
  }

  sqlite3_stmt *existing = NULL;
  sqlite3_prepare_v2(db,
    "SELECT file_id,source_qualified_name,start_line,start_column FROM native_edges WHERE type='CALLS'",
    -1, &existing, NULL);
  while (sqlite3_step(existing) == SQLITE_ROW) {
    resolved_call_add(resolved, resolved_capacity, sqlite3_column_int(existing, 0),
      (const char *)sqlite3_column_text(existing, 1), sqlite3_column_int(existing, 2),
      sqlite3_column_int(existing, 3));
  }
  sqlite3_finalize(existing);

  sqlite3_stmt *insert = NULL;
  sqlite3_prepare_v2(db,
    "INSERT OR IGNORE INTO native_edges(file_id,source_qualified_name,target_qualified_name,type,start_line,start_column,confidence,strategy,evidence_json) "
    "VALUES(?,?,?,'CALLS',?,?,?,?,"
    "json_object('dispatch',?,'callee',?,'language',?,'matched_import',?,'candidates',?,"
    "'macro',?,'expanded_callee',?,'receiver',?,'receiver_type',?))",
    -1, &insert, NULL);
  for (int worker = 0; worker < worker_count; worker++) {
    WorkerBuffer *buffer = &buffers[worker];
    for (size_t index = 0; index < buffer->calls.length; index++) {
      CallObservation *call = &buffer->calls.items[index];
      bool direct_dispatch = strcmp(call->dispatch_kind, "direct") == 0;
      bool member_dispatch = strcmp(call->dispatch_kind, "member") == 0;
      if (!direct_dispatch && !member_dispatch) continue;
      if (!callable_qn_contains(callable_qns, registry_capacity, call->enclosing_qn)) continue;
      int file_id = call->file_index + 1;
      if (resolved_call_contains(resolved, resolved_capacity, file_id, call->enclosing_qn,
                                 call->start_line, call->start_column)) continue;
      const char *language = files[call->file_index].language;
      const char *declared_type = member_dispatch
        ? receiver_declared_type(buffer, call->file_index, call->enclosing_qn,
            call->receiver_text, call->start_line)
        : NULL;
      CallableResolution resolution = member_dispatch && declared_type
        ? callable_registry_resolve_member(registry, registry_capacity, language,
            call->callee_name, declared_type)
        : (direct_dispatch
            ? callable_registry_resolve(registry, registry_capacity, language,
                call->callee_name, &imports_by_file[call->file_index])
            : (CallableResolution){0});
      const char *expanded_callee = NULL;
      if (direct_dispatch && !resolution.qualified_name) {
        expanded_callee = macro_alias_unique(macro_aliases, registry_capacity, language,
                                             call->callee_name);
        if (expanded_callee) {
          resolution = callable_registry_resolve(registry, registry_capacity, language,
            expanded_callee, &imports_by_file[call->file_index]);
          if (resolution.qualified_name) resolution.strategy = "macro_expansion_call";
        }
      }
      if (!resolution.qualified_name ||
          strcmp(resolution.qualified_name, call->enclosing_qn) == 0) continue;
      sqlite3_bind_int(insert, 1, file_id);
      bind_text(insert, 2, call->enclosing_qn);
      bind_text(insert, 3, resolution.qualified_name);
      sqlite3_bind_int(insert, 4, call->start_line);
      sqlite3_bind_int(insert, 5, call->start_column);
      sqlite3_bind_double(insert, 6, resolution.confidence);
      bind_text(insert, 7, resolution.strategy);
      bind_text(insert, 8, call->dispatch_kind);
      bind_text(insert, 9, call->callee_name);
      bind_text(insert, 10, language);
      if (resolution.matched_import) bind_text(insert, 11, resolution.matched_import);
      else sqlite3_bind_null(insert, 11);
      sqlite3_bind_int(insert, 12, resolution.candidate_count);
      if (expanded_callee) {
        bind_text(insert, 13, call->callee_name);
        bind_text(insert, 14, expanded_callee);
      } else {
        sqlite3_bind_null(insert, 13);
        sqlite3_bind_null(insert, 14);
      }
      if (call->receiver_text) bind_text(insert, 15, call->receiver_text);
      else sqlite3_bind_null(insert, 15);
      if (declared_type) bind_text(insert, 16, declared_type);
      else sqlite3_bind_null(insert, 16);
      if (sqlite3_step(insert) == SQLITE_DONE) {
        resolved_call_add(resolved, resolved_capacity, file_id, call->enclosing_qn,
                          call->start_line, call->start_column);
      }
      sqlite3_reset(insert);
      sqlite3_clear_bindings(insert);
    }
  }
  sqlite3_finalize(insert);

  for (size_t index = 0; index < resolved_capacity; index++) {
    free(resolved[index].source_qualified_name);
  }
  for (size_t index = 0; index < registry_capacity; index++) {
    if (registry[index].name) {
      free((void *)registry[index].language);
      free((void *)registry[index].name);
      for (int candidate = 0; candidate < registry[index].implementation_count; candidate++) {
        free(registry[index].implementations[candidate].qualified_name);
        free(registry[index].implementations[candidate].rel_path);
      }
      for (int candidate = 0; candidate < registry[index].header_count; candidate++) {
        free(registry[index].headers[candidate].qualified_name);
        free(registry[index].headers[candidate].rel_path);
      }
      free(registry[index].implementations);
      free(registry[index].headers);
    }
    if (macro_aliases[index].macro_name) {
      free((void *)macro_aliases[index].language);
      free((void *)macro_aliases[index].macro_name);
      free((void *)macro_aliases[index].target_name);
    }
    free(callable_qns[index].qualified_name);
  }
  for (int file = 0; file < file_count; file++) {
    for (size_t imported = 0; imported < imports_by_file[file].length; imported++) {
      free(imports_by_file[file].items[imported]);
    }
    free(imports_by_file[file].items);
  }
  free(imports_by_file);
  free(resolved);
  free(callable_qns);
  free(macro_aliases);
  free(registry);
}

static int write_staging(
  const char *db_path,
  const char *project,
  const char *repo_root,
  FileTask *files,
  int file_count,
  WorkerBuffer *buffers,
  int worker_count
) {
  sqlite3 *db = NULL;
  if (sqlite3_open(db_path, &db) != SQLITE_OK) return -1;
  sql_or_die(db, "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
  sql_or_die(db, LYNX_NATIVE_STAGING_DDL);
  sql_or_die(db, "BEGIN IMMEDIATE;");

  sqlite3_stmt *run = NULL;
  sqlite3_prepare_v2(db, "INSERT INTO native_run VALUES(1,?,'native-core-v1',?,?, 'building',datetime('now'),NULL,NULL)", -1, &run, NULL);
  sqlite3_bind_int(run, 1, LYNX_NATIVE_STAGING_SCHEMA_VERSION);
  bind_text(run, 2, project); bind_text(run, 3, repo_root); sqlite3_step(run); sqlite3_finalize(run);

  sqlite3_stmt *file_stmt = NULL;
  sqlite3_prepare_v2(db, "INSERT INTO native_files(id,rel_path,language,sha256,size_bytes,status,partial_reasons_json) VALUES(?,?,?,?,?,'partial','[\"native-resolution-partial-member-and-qualified\",\"native-resolution-partial-function-pointer\",\"native-preprocessing-partial\",\"native-lexical-shadowing-partial\"]')", -1, &file_stmt, NULL);
  for (int index = 0; index < file_count; index++) {
    sqlite3_bind_int(file_stmt, 1, index + 1);
    bind_text(file_stmt, 2, files[index].rel_path);
    bind_text(file_stmt, 3, files[index].language);
    bind_text(file_stmt, 4, files[index].sha256);
    sqlite3_bind_int64(file_stmt, 5, files[index].size);
    sqlite3_step(file_stmt); sqlite3_reset(file_stmt); sqlite3_clear_bindings(file_stmt);
  }
  sqlite3_finalize(file_stmt);

  sqlite3_stmt *node_stmt = NULL, *call_stmt = NULL, *import_stmt = NULL, *usage_stmt = NULL;
  sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO native_nodes(file_id,kind,name,qualified_name,start_line,end_line,is_exported,is_test,is_entry_point,properties_json) VALUES(?,?,?,?,?,?,?,0,?,CASE WHEN ? IS NULL THEN '{}' ELSE json_object('declared_type',?) END)", -1, &node_stmt, NULL);
  sqlite3_prepare_v2(db, "INSERT INTO native_calls(file_id,enclosing_qualified_name,callee_name,dispatch_kind,receiver_text,start_line,start_column,arguments_json) VALUES(?,?,?,?,?,?,?,'[]')", -1, &call_stmt, NULL);
  sqlite3_prepare_v2(db, "INSERT INTO native_imports(file_id,local_name,imported_name,module_path,resolved_rel_path,start_line) VALUES(?,?,NULL,?,?,?)", -1, &import_stmt, NULL);
  sqlite3_prepare_v2(db, "INSERT INTO native_usages(file_id,enclosing_qualified_name,referenced_name,start_line,start_column,is_write) VALUES(?,?,?,?,?,?)", -1, &usage_stmt, NULL);
  for (int worker = 0; worker < worker_count; worker++) {
    WorkerBuffer *buffer = &buffers[worker];
    for (size_t index = 0; index < buffer->nodes.length; index++) {
      NodeObservation *item = &buffer->nodes.items[index];
      sqlite3_bind_int(node_stmt, 1, item->file_index + 1); bind_text(node_stmt, 2, item->kind);
      bind_text(node_stmt, 3, item->name); bind_text(node_stmt, 4, item->qualified_name);
      sqlite3_bind_int(node_stmt, 5, item->start_line); sqlite3_bind_int(node_stmt, 6, item->end_line);
      sqlite3_bind_int(node_stmt, 7, item->is_exported); sqlite3_bind_int(node_stmt, 8, item->is_entry_point);
      if (item->declared_type) { bind_text(node_stmt, 9, item->declared_type); bind_text(node_stmt, 10, item->declared_type); }
      else { sqlite3_bind_null(node_stmt, 9); sqlite3_bind_null(node_stmt, 10); }
      sqlite3_step(node_stmt); sqlite3_reset(node_stmt); sqlite3_clear_bindings(node_stmt);
    }
    for (size_t index = 0; index < buffer->calls.length; index++) {
      CallObservation *item = &buffer->calls.items[index];
      sqlite3_bind_int(call_stmt, 1, item->file_index + 1); bind_text(call_stmt, 2, item->enclosing_qn);
      bind_text(call_stmt, 3, item->callee_name); bind_text(call_stmt, 4, item->dispatch_kind);
      if (item->receiver_text) bind_text(call_stmt, 5, item->receiver_text);
      else sqlite3_bind_null(call_stmt, 5);
      sqlite3_bind_int(call_stmt, 6, item->start_line);
      sqlite3_bind_int(call_stmt, 7, item->start_column);
      sqlite3_step(call_stmt); sqlite3_reset(call_stmt); sqlite3_clear_bindings(call_stmt);
    }
    for (size_t index = 0; index < buffer->imports.length; index++) {
      ImportObservation *item = &buffer->imports.items[index];
      sqlite3_bind_int(import_stmt, 1, item->file_index + 1); bind_text(import_stmt, 2, item->local_name);
      bind_text(import_stmt, 3, item->module_path);
      char *resolved = item->is_local
        ? resolve_relative_include(files[item->file_index].rel_path, item->module_path)
        : NULL;
      if (resolved) bind_text(import_stmt, 4, resolved);
      else sqlite3_bind_null(import_stmt, 4);
      sqlite3_bind_int(import_stmt, 5, item->start_line);
      sqlite3_step(import_stmt); sqlite3_reset(import_stmt); sqlite3_clear_bindings(import_stmt);
      free(resolved);
    }
    for (size_t index = 0; index < buffer->usages.length; index++) {
      UsageObservation *item = &buffer->usages.items[index];
      sqlite3_bind_int(usage_stmt, 1, item->file_index + 1); bind_text(usage_stmt, 2, item->enclosing_qn);
      bind_text(usage_stmt, 3, item->referenced_name); sqlite3_bind_int(usage_stmt, 4, item->start_line);
      sqlite3_bind_int(usage_stmt, 5, item->start_column);
      sqlite3_bind_int(usage_stmt, 6, item->is_write);
      sqlite3_step(usage_stmt); sqlite3_reset(usage_stmt); sqlite3_clear_bindings(usage_stmt);
    }
  }
  sqlite3_finalize(node_stmt); sqlite3_finalize(call_stmt); sqlite3_finalize(import_stmt); sqlite3_finalize(usage_stmt);
  resolve_staging_edges(db);
  resolve_global_unique_calls(db, files, file_count, buffers, worker_count);
  sql_or_die(db, "UPDATE native_run SET status='complete',completed_at=datetime('now') WHERE singleton=1; COMMIT;");
  sqlite3_close(db);
  return 0;
}

static void free_worker_buffer(WorkerBuffer *buffer) {
  for (size_t index = 0; index < buffer->nodes.length; index++) {
    free(buffer->nodes.items[index].kind);
    free(buffer->nodes.items[index].name);
    free(buffer->nodes.items[index].qualified_name);
    free(buffer->nodes.items[index].declared_type);
  }
  for (size_t index = 0; index < buffer->calls.length; index++) {
    free(buffer->calls.items[index].enclosing_qn);
    free(buffer->calls.items[index].callee_name);
    free(buffer->calls.items[index].dispatch_kind);
    free(buffer->calls.items[index].receiver_text);
  }
  for (size_t index = 0; index < buffer->imports.length; index++) {
    free(buffer->imports.items[index].local_name);
    free(buffer->imports.items[index].module_path);
  }
  for (size_t index = 0; index < buffer->usages.length; index++) {
    free(buffer->usages.items[index].enclosing_qn);
    free(buffer->usages.items[index].referenced_name);
  }
  for (size_t index = 0; index < buffer->macro_aliases.length; index++) {
    free(buffer->macro_aliases.items[index].macro_name);
    free(buffer->macro_aliases.items[index].target_name);
  }
  free(buffer->nodes.items);
  free(buffer->calls.items);
  free(buffer->imports.items);
  free(buffer->usages.items);
  free(buffer->macro_aliases.items);
}

static void free_file_tasks(FileTask *files, int file_count) {
  for (int index = 0; index < file_count; index++) {
    free(files[index].language);
    free(files[index].rel_path);
    free(files[index].abs_path);
  }
  free(files);
}

int main(int argc, char **argv) {
  if (argc != 7) {
    fputs("usage: lynx_native_core <project> <repo-root> <manifest.tsv> <staging.db> <workers> <mode>\n", stderr);
    return 64;
  }
  FileTask *files = NULL;
  int file_count = load_manifest(argv[3], &files);
  if (file_count < 0) return 66;
  int worker_count = atoi(argv[5]);
  if (worker_count < 1) worker_count = 1;
  if (worker_count > file_count && file_count > 0) worker_count = file_count;
  if (worker_count < 1) worker_count = 1;

  WorkerBuffer *buffers = calloc((size_t)worker_count, sizeof(*buffers));
  pthread_t *threads = calloc((size_t)worker_count, sizeof(*threads));
  WorkContext context = {
    .files = files,
    .file_count = file_count,
    .project = argv[1],
    .buffers = buffers,
  };
  atomic_init(&context.next_file, 0);
  atomic_init(&context.next_worker, 0);
  for (int index = 0; index < worker_count; index++) pthread_create(&threads[index], NULL, worker_main, &context);
  for (int index = 0; index < worker_count; index++) pthread_join(threads[index], NULL);

  int result = write_staging(argv[4], argv[1], argv[2], files, file_count, buffers, worker_count);
  for (int index = 0; index < worker_count; index++) free_worker_buffer(&buffers[index]);
  free(buffers);
  free_file_tasks(files, file_count);
  free(threads);
  return result == 0 ? 0 : 74;
}
