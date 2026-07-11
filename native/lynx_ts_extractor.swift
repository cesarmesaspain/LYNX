import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

struct Task: Codable { let id: Int; let project: String; let relPath: String; let absPath: String; let cachedHash: String? }
struct Out: Codable { let id: Int; let file: FileInfo; let result: ResultPayload; let sha256: String; let skipped: Bool? }
struct FileInfo: Codable { let relPath: String; let absPath: String; let extensionName: String; let size: Int
  enum CodingKeys: String, CodingKey { case relPath, absPath, size; case extensionName = "extension" }
}
struct Node: Codable {
  var project: String; var kind: String; var name: String; var qualifiedName: String; var filePath: String
  var startLine: Int; var endLine: Int; var isExported: Bool; var isTest: Bool; var isEntryPoint: Bool
  var extensionName: String?; var lastModified: Int?; var changeCount: Int?; var lineCount: Int?
  var signature: String?; var paramNames: [String]?; var cyclomaticComplexity: Int?; var baseClasses: [String]?
  var baseInterfaces: [String]?; var members: [String]?; var typeAnnotation: String?
  enum CodingKeys: String, CodingKey { case project, kind, name, qualifiedName, filePath, startLine, endLine, isExported, isTest, isEntryPoint; case extensionName = "extension"; case lastModified, changeCount, lineCount, signature, paramNames, cyclomaticComplexity, baseClasses, baseInterfaces, members, typeAnnotation }
}
struct Call: Codable { let calleeName: String; let enclosingFuncQn: String; let args: [String]; let startLine: Int }
struct ImportItem: Codable { let localName: String; let modulePath: String; let startLine: Int }
struct Usage: Codable { let refName: String; let enclosingFuncQn: String; let startLine: Int; let isWrite: Bool? }
struct Channel: Codable { let channelName: String; let transport: String?; let enclosingFuncQn: String?; let direction: String?; let startLine: Int? }
struct ResultPayload: Codable { let nodes: [Node]; let calls: [Call]; let imports: [ImportItem]; let usages: [Usage]; let channels: [Channel]; let hasError: Bool; let errorMsg: String?; let isTestFile: Bool; let language: String }

func moduleQn(_ path: String) -> String {
  var p = path.replacingOccurrences(of: "\\", with: "/")
  if let dot = p.lastIndex(of: ".") { p = String(p[..<dot]) }
  var parts = p.split(separator: "/").map(String.init)
  if parts.last == "index" { parts.removeLast() }
  if parts.first == "src" { parts.removeFirst() }
  return parts.joined(separator: ".")
}

func lineStarts(_ s: String) -> [String.Index] {
  var out: [String.Index] = [s.startIndex]
  var i = s.startIndex
  while i < s.endIndex {
    if s[i] == "\n" { out.append(s.index(after: i)) }
    i = s.index(after: i)
  }
  return out
}

func lineFor(_ starts: [String.Index], _ idx: String.Index, _ s: String) -> Int {
  var lo = 0, hi = starts.count - 1
  while lo <= hi {
    let mid = (lo + hi) / 2
    if starts[mid] <= idx { lo = mid + 1 } else { hi = mid - 1 }
  }
  return hi + 1
}

func nsMatches(_ pattern: String, _ s: String) -> [NSTextCheckingResult] {
  guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return [] }
  return re.matches(in: s, options: [], range: NSRange(s.startIndex..<s.endIndex, in: s))
}

func group(_ m: NSTextCheckingResult, _ n: Int, _ s: String) -> String? {
  let r = m.range(at: n)
  guard r.location != NSNotFound, let range = Range(r, in: s) else { return nil }
  return String(s[range])
}

func idx(_ m: NSTextCheckingResult, _ s: String) -> String.Index {
  return Range(m.range, in: s)?.lowerBound ?? s.startIndex
}

func sha256Hex(_ data: Data) -> String {
  #if canImport(CryptoKit)
  let digest = SHA256.hash(data: data)
  return digest.map { String(format: "%02x", $0) }.joined()
  #else
  return String(data.count)
  #endif
}

func makeBaseNodes(project: String, relPath: String, module: String, lines: Int) -> [Node] {
  let name = URL(fileURLWithPath: relPath).lastPathComponent
  let ext = "." + (relPath.split(separator: ".").last.map(String.init) ?? "")
  let modName = module.split(separator: ".").last.map(String.init) ?? module
  return [
    Node(project: project, kind: "File", name: name, qualifiedName: "\(project).file.\(module)", filePath: relPath, startLine: 1, endLine: lines, isExported: false, isTest: false, isEntryPoint: false, extensionName: ext, lastModified: 0, changeCount: 0, lineCount: nil, signature: nil, paramNames: nil, cyclomaticComplexity: nil, baseClasses: nil, baseInterfaces: nil, members: nil, typeAnnotation: nil),
    Node(project: project, kind: "Module", name: modName, qualifiedName: "\(project).module.\(module)", filePath: relPath, startLine: 1, endLine: lines, isExported: false, isTest: false, isEntryPoint: relPath.hasSuffix("index.ts") || relPath.hasSuffix("index.tsx"), extensionName: nil, lastModified: nil, changeCount: nil, lineCount: lines, signature: nil, paramNames: nil, cyclomaticComplexity: nil, baseClasses: nil, baseInterfaces: nil, members: nil, typeAnnotation: nil)
  ]
}

func runTask(_ task: Task) -> Out {
  let file = FileInfo(relPath: task.relPath, absPath: task.absPath, extensionName: "." + (task.relPath.split(separator: ".").last.map(String.init) ?? ""), size: 0)
  do {
    let data = try Data(contentsOf: URL(fileURLWithPath: task.absPath))
    let hash = sha256Hex(data)
    if let cached = task.cachedHash, cached == hash {
      let empty = ResultPayload(nodes: [], calls: [], imports: [], usages: [], channels: [], hasError: false, errorMsg: nil, isTestFile: false, language: "tsx")
      return Out(id: task.id, file: file, result: empty, sha256: hash, skipped: true)
    }
    guard let source = String(data: data, encoding: .utf8) else { throw NSError(domain: "decode", code: 1) }
    let starts = lineStarts(source)
    let mod = moduleQn(task.relPath)
    var nodes = makeBaseNodes(project: task.project, relPath: task.relPath, module: mod, lines: starts.count)
    var calls: [Call] = []
    var imports: [ImportItem] = []
    var usages: [Usage] = []

    func addNode(kind: String, name: String, at: String.Index, signature: String? = nil) {
      if name.isEmpty || name.hasPrefix("_") { return }
      let line = lineFor(starts, at, source)
      let pre = source[source.index(at, offsetBy: -min(20, source.distance(from: source.startIndex, to: at)))..<at]
      nodes.append(Node(project: task.project, kind: kind, name: name, qualifiedName: "\(mod).\(name)", filePath: task.relPath, startLine: line, endLine: line, isExported: pre.contains("export"), isTest: false, isEntryPoint: false, extensionName: nil, lastModified: nil, changeCount: nil, lineCount: 1, signature: signature, paramNames: [], cyclomaticComplexity: 0, baseClasses: kind == "Class" ? [] : nil, baseInterfaces: kind == "Interface" ? [] : nil, members: kind == "Enum" ? [] : nil, typeAnnotation: kind == "Variable" ? nil : nil))
    }

    let defs: [(String,String)] = [
      ("Function", #"\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"#),
      ("Function", #"\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>"#),
      ("Class", #"\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)"#),
      ("Interface", #"\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)"#),
      ("Type", #"\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)"#),
      ("Enum", #"\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)"#),
      ("Variable", #"\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"#)
    ]
    for (kind, pattern) in defs { for m in nsMatches(pattern, source) { if let name = group(m, 1, source) { addNode(kind: kind, name: name, at: idx(m, source), signature: group(m, 0, source)) } } }
    for m in nsMatches(#"\bimport\s+(?:type\s+)?(?:([^'";]+?)\s+from\s+)?['"]([^'"]+)['"]"#, source) {
      let raw = group(m, 1, source) ?? group(m, 0, source) ?? "import"
      let local = raw.replacingOccurrences(of: "{", with: "").replacingOccurrences(of: "}", with: "").split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ").first.map(String.init) ?? "import" } ?? "import"
      imports.append(ImportItem(localName: local, modulePath: group(m, 2, source) ?? "", startLine: lineFor(starts, idx(m, source), source)))
    }
    for name in nodes.prefix(80).map({ $0.name }) where name.count >= 3 {
      usages.append(Usage(refName: name, enclosingFuncQn: "\(mod)._global", startLine: 1, isWrite: nil))
    }
    let isTest = task.relPath.contains(".test.") || task.relPath.contains(".spec.") || task.relPath.contains("__tests__")
    let result = ResultPayload(nodes: nodes, calls: calls, imports: imports, usages: usages, channels: [], hasError: false, errorMsg: nil, isTestFile: isTest, language: task.relPath.hasSuffix(".tsx") ? "tsx" : "typescript")
    return Out(id: task.id, file: file, result: result, sha256: hash, skipped: nil)
  } catch {
    let result = ResultPayload(nodes: [], calls: [], imports: [], usages: [], channels: [], hasError: true, errorMsg: String(describing: error), isTestFile: false, language: "unknown")
    return Out(id: task.id, file: file, result: result, sha256: "", skipped: nil)
  }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let tasks = (try? JSONDecoder().decode([Task].self, from: input)) ?? []
let outputs = tasks.map(runTask)
let out = try JSONEncoder().encode(outputs)
FileHandle.standardOutput.write(out)
