const t = require("@babel/types");
const ospath = require("path");
const fs = require("fs");
const AST = require("./ast");

class PathFunctions {
  static isRelativePath(path) {
    return path.match(/^\.{0,2}\//);
  }
  
  static isLocalModule(importModulePath) {
    try {
      return !!require.resolve(importModulePath) && !importModulePath.includes("node_modules");
    } catch {
      return false;
    }
  }
  
  static isScriptFile(importModulePath) {
    return importModulePath.match(/\.(js|mjs|jsx|ts|tsx)$/);
  }
  
  static getBaseUrlFromTsconfig() {
    try {
      const filename = ospath.resolve("jsconfig.json");
      const content = JSON.parse(fs.readFileSync(filename, "utf-8"));
      return content?.["compilerOptions"]?.["baseUrl"] || "./";
    } catch (error) {
      throw error;
    }
  }
  
  static getModuleFile(filenameImportFrom, modulePath) {
  // solution for require function for ES modules
  // https://stackoverflow.com/questions/54977743/do-require-resolve-for-es-modules
  // https://stackoverflow.com/a/50053801
  // import { createRequire } from "module";
  // const require = createRequire(import.meta.url);
    try {
      const filenameDir = ospath.dirname(filenameImportFrom);
      const basePath = PathFunctions.isRelativePath(modulePath) ? 
        filenameDir : ospath.resolve(PathFunctions.getBaseUrlFromTsconfig());
      return require.resolve(ospath.resolve(basePath, modulePath));  
    } catch {
      try {
        return require.resolve(modulePath);
      } catch {
        return "MODULE_NOT_FOUND";
      }
    }
  }  
}


class BarrelFilesMapping {
  constructor() {
    this.mapping = {};
  }

  static isBarrelFile(modulePath) {
    return modulePath.endsWith("index.js");
  }

  verifyFilePath (importModuleAbsolutePath) {
    return !BarrelFilesMapping.isBarrelFile(importModuleAbsolutePath) || !PathFunctions.isLocalModule(importModuleAbsolutePath) || !PathFunctions.isScriptFile(importModuleAbsolutePath)
  }  

  createSpecifiersMapping(fullPathModule) {
    const barrelAST = AST.filenameToAST(fullPathModule);
    this.mapping[fullPathModule] = {};
    barrelAST.program.body.forEach((node) => {
      if (t.isExportNamedDeclaration(node)) {
        const originalExportedPath = node.source?.value || fullPathModule;
        const absoluteExportedPath = node.source?.value ? PathFunctions.getModuleFile(fullPathModule, originalExportedPath) : fullPathModule;
        node.specifiers.forEach((specifier) => {
          const specifierName = specifier.exported.name;
          const specifierType = AST.getSpecifierType(specifier);
          this.mapping[fullPathModule][specifierName] =
            this.createDirectSpecifierObject(absoluteExportedPath, specifierName, specifierType);
        });
        if (t.isVariableDeclaration(node.declaration)) {
          const specifierType = "named";
          node.declaration.declarations.forEach((declaration) => {
            const specifierName = declaration.id.name;
            this.mapping[fullPathModule][specifierName] =
              this.createDirectSpecifierObject(absoluteExportedPath, specifierName, specifierType);    
          });
        } else if (t.isFunctionDeclaration(node.declaration)) {
          const specifierType = "named";
          const specifierName = node.declaration.id.name;
          this.mapping[fullPathModule][specifierName] =
            this.createDirectSpecifierObject(absoluteExportedPath, specifierName, specifierType);
        }
      } else if (t.isExportAllDeclaration(node)) {
        const originalExportedPath = node.source.value;
        const absoluteExportedPath = PathFunctions.getModuleFile(fullPathModule, originalExportedPath);
        if (!this.mapping[absoluteExportedPath]) {
          this.createSpecifiersMapping(absoluteExportedPath);
        }
        Object.assign(this.mapping[fullPathModule],this.mapping[absoluteExportedPath]);
      }
    });
  }

  createDirectSpecifierObject(fullPathModule, specifierName, specifierType) {
    if (BarrelFilesMapping.isBarrelFile(fullPathModule)) {
      if (!this.mapping[fullPathModule]) {
        this.createSpecifiersMapping(fullPathModule);
      }
      const originalPath = this.mapping[fullPathModule][specifierName]["path"];
      const originalName = this.mapping[fullPathModule][specifierName]["name"];
      const originalType = this.mapping[fullPathModule][specifierName]["type"];
      return this.createDirectSpecifierObject(originalPath, originalName, originalType);
    }
    return {
      name: specifierName,
      path: fullPathModule,
      type: specifierType,
    };
  }

  getDirectSpecifierObject(fullPathModule, specifierName) {
    if (!this.mapping[fullPathModule]) {
      this.createSpecifiersMapping(fullPathModule);
    }
    return this.mapping[fullPathModule][specifierName];
  }
}

const mapping = new BarrelFilesMapping();

const importDeclarationVisitor = (path, state) => {
  const parsedJSFile = state.filename
  const originalImportsPath = path.node.source.value;
  const originalImportsSpecifiers = path.node.specifiers;
  // const importModulePath = resolve.sync(originalImports.source.value,{basedir: ospath.dirname(state.filename)});
  const importModuleAbsolutePath = PathFunctions.getModuleFile(parsedJSFile, originalImportsPath);
  if (mapping.verifyFilePath(importModuleAbsolutePath)) return;
  const directSpecifierASTArray = originalImportsSpecifiers.map(
    (specifier) => {
      const directSpecifierObject = mapping.getDirectSpecifierObject(
        importModuleAbsolutePath,
        specifier.imported.name
      );
      return AST.createASTImportDeclaration(directSpecifierObject);
    }
  );
  path.replaceWithMultiple(directSpecifierASTArray);
};

module.exports = function (babel) {
  return {
    visitor: {
      ImportDeclaration: importDeclarationVisitor,
    },
  };
};
