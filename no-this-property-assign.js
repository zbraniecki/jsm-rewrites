
let noThisPropertyRead = require("./no-this-property-read");

function isGlobalThis(path) {
  while (path = path.parent) {
    if (
      path.value.type == "FunctionDeclaration" ||
      path.value.type == "FunctionExpression"
    ) {
      return false;
    }
  }

  return true;
}

function hasMatchingGlobalDeclarations(jscodeshift, root, name) {
  let matchingDeclarations = root.find(jscodeshift.VariableDeclaration).filter(function (path) {
    return isGlobalThis(path) &&
            path.value.declarations.length == 1 &&
            path.value.declarations[0].id.name == name;
  });

  let matchingFunctionDeclarations = root.find(jscodeshift.FunctionDeclaration).filter(function (path) {
    return isGlobalThis(path) &&
            path.value.id && path.value.id.name == name;
  });

  return matchingDeclarations.length || matchingFunctionDeclarations.length;
}

function hasMatchingGlobalClasses(jscodeshift, root, name) {
  let matchingClassDeclarations = root.find(jscodeshift.ClassDeclaration).filter(function (path) {
    return isGlobalThis(path) &&
            path.value.id && path.value.id.name == name;
  });
  let matchingClassExpressions = root.find(jscodeshift.ClassExpression).filter(function (path) {
    return isGlobalThis(path) &&
            path.value.id && path.value.id.name == name;
  });

  return matchingClassDeclarations.length || matchingClassExpressions.length;
}

// TODO - Handle:
// https://searchfox.org/mozilla-central/rev/d4d6f81e0ab479cde192453bae83d5e3edfb39d6/toolkit/modules/Timer.jsm#109
// https://searchfox.org/mozilla-central/source/security/manager/ssl/DER.jsm#302

// Some test scripts to handle various cases:
/*
hg revert --all  && jscodeshift toolkit/components/extensions/MessageChannel.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
hg revert --all  && jscodeshift intl/l10n/Localization.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
hg revert --all  && jscodeshift services/fxaccounts/FxAccountsPairing.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
hg revert --all  && jscodeshift toolkit/components/url-classifier/UrlClassifierListManager.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
hg revert --all  && jscodeshift browser/components/newtab/lib/ActivityStreamPrefs.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
hg revert --all  && jscodeshift browser/components/newtab/lib/SearchShortcuts.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
*/

module.exports = function(fileInfo, api) {
  const {jscodeshift} = api;
  const {statement} = jscodeshift.template;
  const root = jscodeshift(fileInfo.source);

  /*
  In https://searchfox.org/mozilla-central/source/browser/components/newtab/common/Reducers.jsm#753,773:
    const TOP_SITES_DEFAULT_ROWS = 1;
    this.TOP_SITES_DEFAULT_ROWS = TOP_SITES_DEFAULT_ROWS;
    const EXPORTED_SYMBOLS = [
      "TOP_SITES_DEFAULT_ROWS",
    ];
  the second statement is unnecessary for the export to work. So it can be removed
  */
 root.find(jscodeshift.AssignmentExpression).filter(function (path) {
  let maybe = path.parent.parent.value.type == "Program" &&
              path.value.left.object &&
              path.value.left.object.type == "ThisExpression" &&
              path.value.right.type == "Identifier" &&
              isGlobalThis(path);
  if (!maybe) {
    return false;
  }
  let name = path.value.right.name;
  if (hasMatchingGlobalDeclarations(jscodeshift, root, name) || hasMatchingGlobalClasses(jscodeshift, root, name)) {
    console.log(`Removed this assignment due to existing top level declaration in ${fileInfo.path}: ${name}`);
    return true;
  }

  return false;
 }).remove();

 root.find(jscodeshift.AssignmentExpression).filter(function (path) {
  let maybe = path.parent.parent.value.type == "Program" &&
              path.value.left.object &&
              path.value.left.object.type == "ThisExpression" &&
              path.value.right.type == "ClassExpression" &&
              isGlobalThis(path);
  if (!maybe) {
    return false;
  }
  let name = path.value.right.id.name;

  // Handle classes like `this.Foo = class Foo {}`: https://searchfox.org/mozilla-central/rev/d4d6f81e0ab479cde192453bae83d5e3edfb39d6/services/fxaccounts/FxAccountsPairing.jsm#172
  // hg revert --all  && jscodeshift services/fxaccounts/FxAccountsPairing.jsm --transform ~/Code/jsm-rewrites/no-this-property-assign.js && hg diff
  if (hasMatchingGlobalClasses(jscodeshift, root, name)) {
    console.log(`Removed this assignment due to existing top level class in ${fileInfo.path}: ${name}`);
    return true;
  }
 }).replaceWith((path) => {
  return jscodeshift.classDeclaration(
    jscodeshift.identifier(path.value.right.id.name),
    jscodeshift.classBody(path.value.right.body.body),
    path.value.right.superClass && jscodeshift.identifier(path.value.right.superClass.name)
  );
});

  /*
  Replace:
    this.bar = 1;
  With:
    const bar = 1;
  */
  root.find(jscodeshift.AssignmentExpression).filter(function (path) {
    // browser/components/newtab/common/Reducers.jsm
    let maybe = path.value.left.object &&
           path.value.left.object.type == "ThisExpression" &&
           isGlobalThis(path);
    if (!maybe) {
      return false;
    }

    return true;
  }).replaceWith(path => {
    // Handle `var Scheduler = (this.Scheduler = {})` to `var Scheduler = {}`
    if (path.parent.value.type == "VariableDeclarator" && path.parent.value.id.loc.identifierName == path.value.left.property.name ||
        path.parent.value.type == "ExpressionStatement" && path.value.left.property &&  path.parent.value.expression.right.id && path.value.left.property.name == path.parent.value.expression.right.id.name) {
      if (path.value.right.type == "FunctionExpression" && path.value.right.id) {
        return jscodeshift.functionDeclaration(
          jscodeshift.identifier(path.value.right.id.name),
          path.value.right.params,
          jscodeshift.blockStatement(path.value.right.body.body)
        );
      }

      return statement`${path.value.right}`;
    }

    // Handle:
    /*
    let Deferred = () => {
      let res = {};
      this._deferredResult = res;
      res.promise = new Promise(this._makeDeferred);
      this._deferredResult = null;
      return res;
    };
    */
    if (path.parent.value.type == "ExpressionStatement" && path.value.left.property && hasMatchingGlobalDeclarations(jscodeshift, root, path.value.left.property.name)) {
      return statement`${path.value.left.property} = ${path.value.right}`;
    }

    let decl;
    if (path.value.left.property.name == "EXPORTED_SYMBOLS") {
      decl = statement`const ${path.value.left.property.name} = ${path.value.right}`;
    } else {
      decl = statement`let ${path.value.left.property.name} = ${path.value.right}`;
    }

    return decl;
  });

  noThisPropertyRead.doTranslate(jscodeshift, root);

  return root.toSource();
};
