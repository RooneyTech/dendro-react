import * as assert from 'assert';
import * as path from 'path';
import {
  getComponentTree,
  getComponentDetails,
  findComponentByName,
  findComponentsByType,
  detectCircularDeps,
  getUsedBy,
  getNavigationStructure,
  getContextMap,
  getScreenComponents,
  getComplexityReport
} from '../../mcp/tools';

// Use src directory for fixtures (they're .tsx files, not compiled)
const FIXTURES_DIR = path.resolve(__dirname, '../../../src/test/fixtures/mcp-tools');

suite('MCP Tools Test Suite', function() {
  this.timeout(30000);

  suiteSetup(function() {
    console.log('Starting MCP tools tests');
    console.log('Fixtures directory:', FIXTURES_DIR);
  });

  suiteTeardown(function() {
    console.log('Finished MCP tools tests');
  });

  // ===========================================
  // getComponentTree Tests
  // ===========================================
  suite('getComponentTree', function() {

    test('should build component tree from valid entry file', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentTree(entryFile);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.tree, 'Tree should not be null');
      assert.strictEqual(result.tree?.file, 'App.tsx');
      assert.ok(result.stats.totalComponents > 0, 'Should have components');
    });

    test('should return correct stats', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentTree(entryFile);

      assert.ok(!result.error);
      // App -> Header -> Navigation, MainContent -> UserProfile, Footer = 6 components
      assert.ok(result.stats.totalComponents >= 6, `Expected at least 6 components, got ${result.stats.totalComponents}`);
      assert.ok(result.stats.functionalCount >= 6, 'Should detect functional components');
      assert.strictEqual(result.stats.classCount, 0, 'Should have no class components in main tree');
    });

    test('should detect RSC directives', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentTree(entryFile);

      assert.ok(!result.error);
      assert.ok(result.tree, 'Tree should exist');

      // Find Header (use client) in children
      const header = result.tree?.children?.find(c => c.file === 'Header.tsx');
      assert.ok(header, 'Should find Header component');
      assert.strictEqual(header?.directive, 'use client', 'Header should have "use client" directive');

      // Find MainContent -> UserProfile (use server)
      const mainContent = result.tree?.children?.find(c => c.file === 'MainContent.tsx');
      assert.ok(mainContent, 'Should find MainContent component');
      const userProfile = mainContent?.children?.find(c => c.file === 'UserProfile.tsx');
      assert.ok(userProfile, 'Should find UserProfile component');
      assert.strictEqual(userProfile?.directive, 'use server', 'UserProfile should have "use server" directive');
    });

    test('should respect maxDepth parameter', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentTree(entryFile, 1);

      assert.ok(!result.error);
      assert.ok(result.tree, 'Tree should exist');

      // At depth 1, children should exist but grandchildren should be empty
      assert.ok(result.tree?.children?.length ?? 0 > 0, 'Should have children');
      for (const child of result.tree?.children || []) {
        assert.strictEqual(child.children.length, 0, `Child ${child.file} should have no children at maxDepth=1`);
      }
    });

    test('should return error for non-existent file', function() {
      const entryFile = path.join(FIXTURES_DIR, 'NonExistent.tsx');
      const result = getComponentTree(entryFile);

      assert.ok(result.error, 'Should have an error');
      assert.ok(result.error?.includes('not found'), 'Error should mention file not found');
      assert.strictEqual(result.tree, null);
    });

    test('should handle file with no children', function() {
      const entryFile = path.join(FIXTURES_DIR, 'Standalone.tsx');
      const result = getComponentTree(entryFile);

      assert.ok(!result.error);
      assert.ok(result.tree, 'Tree should exist');
      assert.strictEqual(result.tree?.children?.length, 0, 'Standalone should have no children');
      assert.strictEqual(result.stats.totalComponents, 1);
    });
  });

  // ===========================================
  // getComponentDetails Tests
  // ===========================================
  suite('getComponentDetails', function() {

    test('should return details for functional component', function() {
      const filePath = path.join(FIXTURES_DIR, 'Header.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.file, 'Header.tsx');
      assert.strictEqual(result.type, 'functional');
      assert.strictEqual(result.directive, 'use client');
      assert.ok(result.state.includes('menuOpen'), 'Should detect useState variable');
    });

    test('should return details for class component', function() {
      const filePath = path.join(FIXTURES_DIR, 'ClassComponent.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.file, 'ClassComponent.tsx');
      assert.strictEqual(result.type, 'class');
    });

    test('should list imports correctly', function() {
      const filePath = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(!result.error);
      assert.ok(result.imports.length > 0, 'Should have imports');

      // Parser captures local/relative imports (component imports)
      const localImports = result.imports.filter(i => i.isLocal);
      assert.ok(localImports.length >= 3, 'Should have at least 3 local imports');

      // Verify specific imports are captured
      assert.ok(result.imports.some(i => i.source === './Header'), 'Should have Header import');
      assert.ok(result.imports.some(i => i.source === './MainContent'), 'Should have MainContent import');
      assert.ok(result.imports.some(i => i.source === './Footer'), 'Should have Footer import');
    });

    test('should list direct children', function() {
      const filePath = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(!result.error);
      assert.ok(result.directChildren.includes('Header.tsx'), 'Should include Header.tsx');
      assert.ok(result.directChildren.includes('MainContent.tsx'), 'Should include MainContent.tsx');
      assert.ok(result.directChildren.includes('Footer.tsx'), 'Should include Footer.tsx');
    });

    test('should detect multiple state variables', function() {
      const filePath = path.join(FIXTURES_DIR, 'MainContent.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(!result.error);
      assert.ok(result.state.includes('data'), 'Should detect data state');
      assert.ok(result.state.includes('loading'), 'Should detect loading state');
    });

    test('should return error for non-existent file', function() {
      const filePath = path.join(FIXTURES_DIR, 'NonExistent.tsx');
      const result = getComponentDetails(filePath);

      assert.ok(result.error, 'Should have an error');
      assert.ok(result.error?.includes('not found'));
    });
  });

  // ===========================================
  // findComponentByName Tests
  // ===========================================
  suite('findComponentByName', function() {

    test('should find component by exact name', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'Header', true);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.matches.length, 1, 'Should find exactly one match');
      assert.strictEqual(result.matches[0].file, 'Header.tsx');
    });

    test('should find components by partial name', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'Content', false);

      assert.ok(!result.error);
      assert.ok(result.matches.length >= 1, 'Should find at least one match');
      assert.ok(result.matches.some(m => m.file === 'MainContent.tsx'), 'Should find MainContent');
    });

    test('should return empty matches for non-existent component', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'NonExistent', true);

      assert.ok(!result.error);
      assert.strictEqual(result.matches.length, 0, 'Should have no matches');
      assert.ok(result.totalSearched > 0, 'Should have searched components');
    });

    test('should include path and depth in matches', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'Navigation', true);

      assert.ok(!result.error);
      assert.strictEqual(result.matches.length, 1);

      const match = result.matches[0];
      assert.ok(match.path.length > 0, 'Should have path');
      assert.ok(match.depth >= 0, 'Should have depth');
      assert.ok(match.path.includes('App.tsx'), 'Path should include App.tsx');
    });

    test('should include directive in matches', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'Header', true);

      assert.ok(!result.error);
      assert.strictEqual(result.matches[0].directive, 'use client');
    });

    test('should be case-insensitive', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentByName(entryFile, 'header', true);

      assert.ok(!result.error);
      assert.strictEqual(result.matches.length, 1, 'Should find Header with lowercase search');
    });
  });

  // ===========================================
  // findComponentsByType Tests
  // ===========================================
  suite('findComponentsByType', function() {

    test('should find all functional components', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentsByType(entryFile, 'functional');

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.components.length >= 6, `Should find at least 6 functional components, got ${result.components.length}`);
    });

    test('should find class components', function() {
      // Use ClassComponent as entry to ensure it's in the tree
      const entryFile = path.join(FIXTURES_DIR, 'ClassComponent.tsx');
      const result = findComponentsByType(entryFile, 'class');

      assert.ok(!result.error);
      assert.strictEqual(result.components.length, 1, 'Should find 1 class component');
      assert.strictEqual(result.components[0].file, 'ClassComponent.tsx');
    });

    test('should include absolutePath in results', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = findComponentsByType(entryFile, 'functional');

      assert.ok(!result.error);
      assert.ok(result.components.length > 0);

      for (const comp of result.components) {
        assert.ok(comp.absolutePath, 'Should have absolutePath');
        assert.ok(path.isAbsolute(comp.absolutePath), 'absolutePath should be absolute');
      }
    });

    test('should include state variables', function() {
      const entryFile = path.join(FIXTURES_DIR, 'Header.tsx');
      const result = findComponentsByType(entryFile, 'functional');

      assert.ok(!result.error);
      const header = result.components.find(c => c.file === 'Header.tsx');
      assert.ok(header, 'Should find Header');
      assert.ok(header?.state.includes('menuOpen'), 'Should include state variables');
    });

    test('should return error for non-existent entry file', function() {
      const entryFile = path.join(FIXTURES_DIR, 'NonExistent.tsx');
      const result = findComponentsByType(entryFile, 'functional');

      assert.ok(result.error, 'Should have error');
      assert.strictEqual(result.components.length, 0);
    });
  });

  // ===========================================
  // detectCircularDeps Tests
  // ===========================================
  suite('detectCircularDeps', function() {
    const CIRCULAR_FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/circular-fixtures');

    test('should detect circular dependencies from entry file', function() {
      const entryFile = path.join(FIXTURES_DIR, 'CircularA.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.hasCircularDeps, true, 'Should detect circular dependency');
      assert.ok(result.circularDependencies.length > 0, 'Should have circular dependency info');
    });

    test('should provide cycle description', function() {
      const entryFile = path.join(FIXTURES_DIR, 'CircularA.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.ok(result.circularDependencies.length > 0);

      const cycle = result.circularDependencies[0];
      assert.ok(cycle.cycle.length >= 2, 'Cycle should have at least 2 files');
      assert.ok(cycle.description, 'Should have description');
      assert.ok(cycle.description.includes('→'), 'Description should show arrow notation');
    });

    test('should provide full paths for cycles', function() {
      const entryFile = path.join(FIXTURES_DIR, 'CircularA.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.ok(result.circularDependencies.length > 0);

      const cycle = result.circularDependencies[0];
      assert.ok(cycle.fullPath, 'Should have fullPath');
      assert.ok(cycle.fullPath.length >= 2, 'fullPath should have at least 2 entries');
      assert.ok(path.isAbsolute(cycle.fullPath[0]), 'fullPath entries should be absolute');
    });

    test('should provide recommendations for breaking cycles', function() {
      const entryFile = path.join(FIXTURES_DIR, 'CircularA.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.ok(result.circularDependencies.length > 0);

      const cycle = result.circularDependencies[0];
      assert.ok(cycle.recommendation, 'Should have recommendation');
      assert.ok(cycle.recommendation.length > 10, 'Recommendation should be meaningful');
    });

    test('should generate formatted output', function() {
      const entryFile = path.join(FIXTURES_DIR, 'CircularA.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.ok(result.formattedOutput, 'Should have formatted output');
      assert.ok(result.formattedOutput.includes('Circular Dependencies Detected'), 'Formatted output should have header');
      assert.ok(result.formattedOutput.includes('Recommendation'), 'Formatted output should include recommendations');
    });

    test('should not report circular deps when none exist', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.strictEqual(result.hasCircularDeps, false, 'Should not have circular deps');
      assert.strictEqual(result.circularDependencies.length, 0);
      assert.ok(result.formattedOutput.includes('No circular dependencies detected'), 'Should say no cycles found');
    });

    test('should report files scanned count', function() {
      const entryFile = path.join(FIXTURES_DIR, 'App.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(!result.error);
      assert.ok(result.totalFilesScanned > 0, 'Should report files scanned');
    });

    test('should return error for non-existent file', function() {
      const entryFile = path.join(FIXTURES_DIR, 'NonExistent.tsx');
      const result = detectCircularDeps(entryFile);

      assert.ok(result.error, 'Should have error');
      assert.strictEqual(result.hasCircularDeps, false);
    });

    test('should scan directory for circular dependencies', function() {
      const result = detectCircularDeps(CIRCULAR_FIXTURES);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.hasCircularDeps, true, 'Should detect circular deps in directory');
      assert.ok(result.totalFilesScanned >= 3, 'Should scan at least 3 files');
    });

    test('should detect barrel export cycles', function() {
      const result = detectCircularDeps(CIRCULAR_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.circularDependencies.length > 0, 'Should find barrel export cycle');

      // Check that the cycle involves the barrel (utils/index.ts or selectionTypeConverters)
      const hasBarrelCycle = result.circularDependencies.some(dep =>
        dep.cycle.some(f => f.includes('selectionTypeConverters') || f.includes('index'))
      );
      assert.ok(hasBarrelCycle, 'Should detect cycle through barrel export');
    });

    test('should provide barrel-specific recommendation', function() {
      const result = detectCircularDeps(CIRCULAR_FIXTURES);

      assert.ok(!result.error);
      const barrelCycle = result.circularDependencies.find(dep =>
        dep.fullPath.some(p => p.includes('index.ts'))
      );

      // If a barrel cycle is found, it should have appropriate recommendation
      if (barrelCycle) {
        assert.ok(
          barrelCycle.recommendation.includes('barrel') || barrelCycle.recommendation.includes('separate'),
          'Barrel cycle should have relevant recommendation'
        );
      }
    });
  });

  // ===========================================
  // getUsedBy Tests
  // ===========================================
  suite('getUsedBy', function() {

    test('should find components that use a given component', function() {
      const componentPath = path.join(FIXTURES_DIR, 'Header.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.component, 'Header.tsx');
      assert.ok(result.usedBy.length >= 1, 'Should be used by at least one component');
      assert.ok(result.usedBy.some(u => u.file === 'App.tsx'), 'Should be used by App.tsx');
    });

    test('should return empty array for unused component', function() {
      const componentPath = path.join(FIXTURES_DIR, 'Standalone.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error);
      assert.strictEqual(result.usedBy.length, 0, 'Standalone should not be used by anyone');
    });

    test('should include import statement in results', function() {
      const componentPath = path.join(FIXTURES_DIR, 'Navigation.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error);
      assert.ok(result.usedBy.length >= 1);

      const usage = result.usedBy[0];
      assert.ok(usage.importStatement, 'Should have import statement');
      assert.ok(usage.importStatement.includes('Navigation'), 'Import should reference Navigation');
    });

    test('should include component type and directive', function() {
      const componentPath = path.join(FIXTURES_DIR, 'Navigation.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error);
      assert.ok(result.usedBy.length >= 1);

      const usage = result.usedBy.find(u => u.file === 'Header.tsx');
      assert.ok(usage, 'Should be used by Header.tsx');
      assert.strictEqual(usage?.type, 'functional');
      assert.strictEqual(usage?.directive, 'use client');
    });

    test('should report total files scanned', function() {
      const componentPath = path.join(FIXTURES_DIR, 'Header.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error);
      assert.ok(result.totalFilesScanned > 0, 'Should report files scanned');
    });

    test('should return error for non-existent component', function() {
      const componentPath = path.join(FIXTURES_DIR, 'NonExistent.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(result.error, 'Should have error');
      assert.ok(result.error?.includes('not found'));
    });

    test('should not include self in usedBy results', function() {
      const componentPath = path.join(FIXTURES_DIR, 'App.tsx');
      const result = getUsedBy(componentPath, FIXTURES_DIR);

      assert.ok(!result.error);
      assert.ok(!result.usedBy.some(u => u.file === 'App.tsx'), 'Should not include self');
    });
  });

  // ===========================================
  // getNavigationStructure Tests
  // ===========================================
  suite('getNavigationStructure', function() {
    const NAVIGATION_FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/navigation');

    test('should detect navigators from a file', function() {
      const rootFile = path.join(NAVIGATION_FIXTURES, 'RootNavigator.tsx');
      const result = getNavigationStructure(rootFile);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.totalNavigators >= 1, 'Should detect at least one navigator');
      assert.ok(result.navigators.some(n => n.type === 'NativeStack'), 'Should detect NativeStack navigator');
    });

    test('should detect screens in navigators', function() {
      const rootFile = path.join(NAVIGATION_FIXTURES, 'RootNavigator.tsx');
      const result = getNavigationStructure(rootFile);

      assert.ok(!result.error);
      assert.ok(result.totalScreens >= 3, 'Should detect at least 3 screens');
      assert.ok(result.screens.some(s => s.name === 'Main'), 'Should detect Main screen');
      assert.ok(result.screens.some(s => s.name === 'Settings'), 'Should detect Settings screen');
    });

    test('should detect nested navigators', function() {
      const rootFile = path.join(NAVIGATION_FIXTURES, 'RootNavigator.tsx');
      const result = getNavigationStructure(rootFile);

      assert.ok(!result.error);
      assert.ok(result.tree, 'Should have tree');
      assert.ok(result.tree?.children && result.tree.children.length > 0, 'Should have nested navigators');
      assert.ok(result.tree?.children.some(c => c.navigator.type === 'BottomTab'), 'Should detect BottomTab navigator');
    });

    test('should resolve component paths', function() {
      const rootFile = path.join(NAVIGATION_FIXTURES, 'RootNavigator.tsx');
      const result = getNavigationStructure(rootFile);

      assert.ok(!result.error);
      const mainScreen = result.screens.find(s => s.name === 'Main');
      assert.ok(mainScreen, 'Should find Main screen');
      assert.ok(mainScreen?.componentPath, 'Main screen should have componentPath resolved');
      assert.ok(mainScreen?.componentPath?.includes('TabNavigator.tsx'), 'componentPath should point to TabNavigator');
    });

    test('should generate formatted tree', function() {
      const rootFile = path.join(NAVIGATION_FIXTURES, 'RootNavigator.tsx');
      const result = getNavigationStructure(rootFile);

      assert.ok(!result.error);
      assert.ok(result.formattedTree, 'Should have formatted tree');
      assert.ok(result.formattedTree.includes('NativeStack'), 'Formatted tree should show NativeStack');
      assert.ok(result.formattedTree.includes('BottomTab'), 'Formatted tree should show BottomTab');
    });

    test('should scan directory for all navigators', function() {
      const result = getNavigationStructure(NAVIGATION_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.totalNavigators >= 2, 'Should find at least 2 navigators');
      assert.strictEqual(result.totalScreens, 6, 'Should find 6 screens');
    });

    test('should return error for non-existent path', function() {
      const result = getNavigationStructure('/non/existent/path');

      assert.ok(result.error, 'Should have error');
      assert.ok(result.error?.includes('not found'), 'Error should mention path not found');
    });
  });

  // ===========================================
  // getContextMap Tests
  // ===========================================
  suite('getContextMap', function() {
    const CONTEXT_FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/context');

    test('should detect context definitions', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.strictEqual(result.totalContexts, 2, 'Should detect 2 contexts');
      assert.ok(result.contexts.some(c => c.variableName === 'AuthContext'), 'Should detect AuthContext');
      assert.ok(result.contexts.some(c => c.variableName === 'TabBarContext'), 'Should detect TabBarContext');
    });

    test('should detect provider usages', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.providers.length >= 2, 'Should detect at least 2 providers');
      assert.ok(result.providers.some(p => p.contextName === 'Auth'), 'Should detect AuthContext.Provider');
      assert.ok(result.providers.some(p => p.contextName === 'TabBar'), 'Should detect TabBarContext.Provider');
    });

    test('should detect useContext consumers', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.totalConsumers >= 3, 'Should detect at least 3 consumers');

      // Should find BottomTabNavigator using useContext directly
      assert.ok(
        result.consumers.some(c => c.componentName === 'BottomTabNavigator' && c.hookName === 'useContext'),
        'Should detect BottomTabNavigator using useContext'
      );
    });

    test('should detect custom hooks wrapping useContext', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.customHooks.length >= 2, 'Should detect at least 2 custom hooks');
      assert.ok(result.customHooks.some(h => h.hookName === 'useAuth'), 'Should detect useAuth hook');
      assert.ok(result.customHooks.some(h => h.hookName === 'useTabBar'), 'Should detect useTabBar hook');
    });

    test('should detect components using custom hooks', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);

      // ProfileScreen uses useAuth
      assert.ok(
        result.consumers.some(c => c.componentName === 'ProfileScreen' && c.hookName === 'useAuth'),
        'Should detect ProfileScreen using useAuth'
      );

      // SettingsScreen uses both useAuth and useTabBar
      assert.ok(
        result.consumers.some(c => c.componentName === 'SettingsScreen' && c.hookName === 'useAuth'),
        'Should detect SettingsScreen using useAuth'
      );
      assert.ok(
        result.consumers.some(c => c.componentName === 'SettingsScreen' && c.hookName === 'useTabBar'),
        'Should detect SettingsScreen using useTabBar'
      );
    });

    test('should build hierarchy mapping contexts to consumers', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.hierarchy.length >= 2, 'Should have hierarchy for at least 2 contexts');

      const authHierarchy = result.hierarchy.find(h => h.contextName === 'Auth');
      assert.ok(authHierarchy, 'Should have Auth context in hierarchy');
      assert.ok(authHierarchy?.consumers.length >= 2, 'Auth should have at least 2 consumers');
    });

    test('should generate formatted tree', function() {
      const result = getContextMap(CONTEXT_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.formattedTree, 'Should have formatted tree');
      assert.ok(result.formattedTree.includes('AuthProvider'), 'Formatted tree should show AuthProvider');
      assert.ok(result.formattedTree.includes('TabBarProvider'), 'Formatted tree should show TabBarProvider');
      assert.ok(result.formattedTree.includes('Consumers:'), 'Formatted tree should show consumers');
    });

    test('should scan single file', function() {
      const singleFile = path.join(CONTEXT_FIXTURES, 'AuthContext.tsx');
      const result = getContextMap(singleFile);

      assert.ok(!result.error);
      assert.strictEqual(result.totalContexts, 1, 'Should detect 1 context from single file');
      assert.ok(result.contexts[0].variableName === 'AuthContext', 'Should be AuthContext');
    });

    test('should return error for non-existent path', function() {
      const result = getContextMap('/non/existent/path');

      assert.ok(result.error, 'Should have error');
      assert.ok(result.error?.includes('not found'), 'Error should mention path not found');
    });
  });

  // ===========================================
  // getScreenComponents Tests
  // ===========================================
  suite('getScreenComponents', function() {
    const SCREENS_FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/screen-fixtures');

    test('should detect screens from navigation configuration', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.totalScreens >= 3, 'Should detect at least 3 screens');
    });

    test('should detect screens from navigation with correct names', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error);
      // Screens from navigation config should use their navigation names
      assert.ok(result.screens.some(s => s.screen.name === 'Feed'), 'Should detect Feed screen');
      assert.ok(result.screens.some(s => s.screen.name === 'Profile'), 'Should detect Profile screen');
      assert.ok(result.screens.some(s => s.screen.name === 'Settings'), 'Should detect Settings screen');
    });

    test('should map components used by each screen', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error);
      const feedScreen = result.screens.find(s => s.screen.name === 'Feed');
      assert.ok(feedScreen, 'Should find Feed screen');
      assert.ok(feedScreen?.totalComponents >= 2, 'Feed should use at least 2 components');
      assert.ok(feedScreen?.components.some(c => c.name === 'PostCard'), 'Feed should use PostCard');
      assert.ok(feedScreen?.components.some(c => c.name === 'Header'), 'Feed should use Header');
    });

    test('should detect nested component usage', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error);
      const feedScreen = result.screens.find(s => s.screen.name === 'Feed');
      assert.ok(feedScreen, 'Should find Feed screen');

      // PostCard uses UserAvatar and LikeButton
      const postCard = feedScreen?.components.find(c => c.name === 'PostCard');
      assert.ok(postCard, 'Should find PostCard');
      assert.ok(postCard?.children.some(c => c.name === 'UserAvatar'), 'PostCard should use UserAvatar');
      assert.ok(postCard?.children.some(c => c.name === 'LikeButton'), 'PostCard should use LikeButton');
    });

    test('should calculate depth metrics', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error);
      const feedScreen = result.screens.find(s => s.screen.name === 'Feed');
      assert.ok(feedScreen, 'Should find Feed screen');
      assert.ok(feedScreen?.maxDepth >= 2, 'Feed should have maxDepth >= 2 (PostCard -> UserAvatar)');
    });

    test('should filter by screen name', function() {
      const result = getScreenComponents(SCREENS_FIXTURES, 'Feed');

      assert.ok(!result.error);
      assert.strictEqual(result.totalScreens, 1, 'Should find exactly 1 screen matching Feed');
      assert.strictEqual(result.screens[0].screen.name, 'Feed');
    });

    test('should generate formatted tree', function() {
      const result = getScreenComponents(SCREENS_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.formattedTree, 'Should have formatted tree');
      assert.ok(result.formattedTree.includes('Feed'), 'Formatted tree should show Feed');
      assert.ok(result.formattedTree.includes('PostCard'), 'Formatted tree should show PostCard');
    });

    test('should return error for non-existent path', function() {
      const result = getScreenComponents('/non/existent/path');

      assert.ok(result.error, 'Should have error');
      assert.ok(result.error?.includes('not found'), 'Error should mention path not found');
    });

    test('should return warning when no screens match filter', function() {
      const result = getScreenComponents(SCREENS_FIXTURES, 'NonExistentScreen');

      assert.ok(!result.error);
      assert.strictEqual(result.totalScreens, 0, 'Should find no screens');
      assert.ok(result.warnings.some(w => w.includes('No screens found')), 'Should have warning about no matches');
    });
  });

  // ===========================================
  // getComplexityReport Tests
  // ===========================================
  suite('getComplexityReport', function() {
    const COMPLEXITY_FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/complexity-fixtures');

    test('should analyze complexity of all components in directory', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error, `Unexpected error: ${result.error}`);
      assert.ok(result.components.length >= 4, `Expected at least 4 components, got ${result.components.length}`);
      assert.ok(result.summary.totalComponents >= 4, 'Should have at least 4 components in summary');
    });

    test('should identify medium/high complexity components', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      // ComplexForm should be identified as medium or high complexity (score >= 6)
      const complexForm = result.components.find(c => c.file === 'ComplexForm.tsx');
      assert.ok(complexForm, 'Should find ComplexForm');
      assert.ok(
        complexForm?.rating === 'medium' || complexForm?.rating === 'high',
        `ComplexForm should be rated as medium or high, got ${complexForm?.rating}`
      );
      assert.ok(complexForm?.score >= 5, `ComplexForm score should be >= 5, got ${complexForm?.score}`);
    });

    test('should identify low complexity components', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      // Badge should be identified as low complexity
      const badge = result.components.find(c => c.file === 'Badge.tsx');
      assert.ok(badge, 'Should find Badge');
      assert.strictEqual(badge?.rating, 'low', 'Badge should be rated as low complexity');
      assert.ok(badge?.score < 3, `Badge score should be < 3, got ${badge?.score}`);
    });

    test('should calculate complexity metrics accurately', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      const complexForm = result.components.find(c => c.file === 'ComplexForm.tsx');
      assert.ok(complexForm, 'Should find ComplexForm');

      // ComplexForm has: ~280 lines, multiple state hooks, multiple effects
      assert.ok(complexForm?.metrics.lines > 200, `Lines should be > 200, got ${complexForm?.metrics.lines}`);
      assert.ok(complexForm?.metrics.stateCount >= 5, `State count should be >= 5, got ${complexForm?.metrics.stateCount}`);
      assert.ok(complexForm?.metrics.effectCount >= 3, `Effect count should be >= 3, got ${complexForm?.metrics.effectCount}`);
    });

    test('should sort components by score descending', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.components.length >= 2, 'Should have at least 2 components');

      // Verify sorted by score descending
      for (let i = 1; i < result.components.length; i++) {
        assert.ok(
          result.components[i - 1].score >= result.components[i].score,
          `Components should be sorted by score descending at index ${i}`
        );
      }
    });

    test('should calculate summary statistics', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      // At least one component should be medium or high complexity
      assert.ok(result.summary.high >= 0 || result.summary.medium >= 1, 'Should have at least 1 medium/high complexity component');
      assert.ok(result.summary.low >= 1, 'Should have at least 1 low complexity component');
      assert.ok(result.summary.average > 0, 'Average should be > 0');
      assert.strictEqual(
        result.summary.high + result.summary.medium + result.summary.low,
        result.summary.totalComponents,
        'Sum of ratings should equal total'
      );
    });

    test('should generate formatted report', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      assert.ok(result.formattedReport, 'Should have formatted report');
      assert.ok(result.formattedReport.includes('Complexity Report'), 'Report should have header');
      assert.ok(result.formattedReport.includes('Summary'), 'Report should have summary section');
    });

    test('should apply threshold filter', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES, 5);

      assert.ok(!result.error);
      // Only components with score >= 5 should be included
      for (const comp of result.components) {
        assert.ok(comp.score >= 5, `Component ${comp.file} with score ${comp.score} should be >= threshold 5`);
      }
    });

    test('should handle single file path', function() {
      const singleFile = path.join(COMPLEXITY_FIXTURES, 'ProfileCard.tsx');
      const result = getComplexityReport(singleFile);

      assert.ok(!result.error);
      assert.strictEqual(result.components.length, 1, 'Should analyze single file');
      assert.strictEqual(result.components[0].file, 'ProfileCard.tsx');
    });

    test('should return error for non-existent path', function() {
      const result = getComplexityReport('/non/existent/path');

      assert.ok(result.error, 'Should have error');
      assert.ok(result.error?.includes('not found'), 'Error should mention path not found');
    });

    test('should detect component names', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      const complexForm = result.components.find(c => c.file === 'ComplexForm.tsx');
      assert.ok(complexForm, 'Should find ComplexForm');
      assert.strictEqual(complexForm?.componentName, 'ComplexForm', 'Should detect component name');
    });

    test('should count props correctly', function() {
      const result = getComplexityReport(COMPLEXITY_FIXTURES);

      assert.ok(!result.error);
      // ComplexForm has 11 props
      const complexForm = result.components.find(c => c.file === 'ComplexForm.tsx');
      assert.ok(complexForm, 'Should find ComplexForm');
      assert.ok(complexForm?.metrics.propsCount >= 10, `ComplexForm should have >= 10 props, got ${complexForm?.metrics.propsCount}`);
    });
  });
});
