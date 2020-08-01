import { Block, BlockCompiler, BlockFactory, Options as CSSBlocksOptions, SerializedSourceAnalysis, resolveConfiguration } from "@css-blocks/core";
import { BroccoliTreeImporter, EmberAnalysis, EmberAnalyzer, TEMPLATE_TYPE, pathToIdent } from "@css-blocks/ember-support";
import { unionInto } from "@opticss/util";
import mergeTrees = require("broccoli-merge-trees");
import type { InputNode } from "broccoli-node-api";
import Filter = require("broccoli-persistent-filter");
import Plugin = require("broccoli-plugin");
import type { PluginOptions } from "broccoli-plugin/dist/interfaces";
import debugGenerator from "debug";
import * as FSTree from "fs-tree-diff";
import { Optimizer, postcss } from "opticss";
import * as path from "path";

import { RuntimeDataGenerator } from "./RuntimeDataGenerator";

const debug = debugGenerator("css-blocks:ember-app");

export class CSSBlocksApplicationPlugin extends Filter {
  appName: string;
  previousSourceTree: FSTree;
  cssBlocksOptions: CSSBlocksOptions;
  constructor(appName: string, inputNodes: InputNode[], cssBlocksOptions: CSSBlocksOptions, options?: PluginOptions) {
    super(mergeTrees(inputNodes), options || {});
    this.appName = appName;
    this.previousSourceTree = new FSTree();
    this.cssBlocksOptions = cssBlocksOptions;
  }
  processString(contents: string, _relativePath: string): string {
    return contents;
  }
  async build() {
    await super.build();
    let entries = this.input.entries(".", {globs: ["**/*.{compiledblock.css,block-analysis.json}"]});
    let currentFSTree = FSTree.fromEntries(entries);
    let patch = this.previousSourceTree.calculatePatch(currentFSTree);
    if (patch.length === 0) {
      // nothing changed from the last build.
      return;
    } else {
      this.previousSourceTree = currentFSTree;
    }
    let config = resolveConfiguration(this.cssBlocksOptions);
    let importer = new BroccoliTreeImporter(this.input, null, config.importer);
    config = resolveConfiguration({importer}, config);
    let factory = new BlockFactory(config, postcss);
    let analyzer = new EmberAnalyzer(factory);
    // TODO: Make this configurable from the ember app.
    let optimizerOptions = {
      enabled: true,
      rewriteIdents: {
        id: false,
        class: true,
        omitIdents: {
          class: [], // TODO: scan css files for other classes in use.
        },
      },
      removeUnusedStyles: false,
      mergeDeclarations: false,
    };
    let optimizer = new Optimizer(optimizerOptions, analyzer.optimizationOptions);
    let blocksUsed = new Set<Block>();
    for (let entry of entries) {
      if (entry.relativePath.endsWith(".block-analysis.json")) {
        debug(`Processing analysis: ${entry.relativePath}`);
        let serializedAnalysis: SerializedSourceAnalysis<TEMPLATE_TYPE> = JSON.parse(this.input.readFileSync(entry.relativePath, "utf8"));
        debug("blocks", serializedAnalysis.stylesFound);
        for (let blockId of Object.keys(serializedAnalysis.blocks)) {
          serializedAnalysis.blocks[blockId] = pathToIdent(serializedAnalysis.blocks[blockId]);
        }
        let analysis = await EmberAnalysis.deserializeSource(serializedAnalysis, factory, analyzer);
        unionInto(blocksUsed, analysis.transitiveBlockDependencies());
        optimizer.addAnalysis(analysis.forOptimizer(config));
      }
    }
    let compiler = new BlockCompiler(postcss, config);
    let reservedClassnames = analyzer.reservedClassNames();
    for (let block of blocksUsed) {
      let content: postcss.Result;
      let filename = importer.debugIdentifier(block.identifier, config);
      if (block.precompiledStylesheet) {
        debug(`Optimizing precompiled stylesheet for ${filename}`);
        content = block.precompiledStylesheet.toResult();
      } else {
        debug(`Compiling stylesheet for optimization of ${filename}`);
        // XXX Do we need to worry about reservedClassnames here?
        content = compiler.compile(block, block.stylesheet!, reservedClassnames).toResult();
      }
      optimizer.addSource({
        content,
        filename,
      });
    }
    debug(`Loaded ${blocksUsed.size} blocks.`);
    debug(`Loaded ${optimizer.analyses.length} analyses.`);
    let cssFileName = `${this.appName}/styles/css-blocks.css`;
    let sourceMapFileName = `${this.appName}/styles/css-blocks.css.map`;
    let optLogFileName = `${this.appName}/styles/css-blocks.optimization.log`;
    let optimizationResult = await optimizer.optimize(cssFileName);
    debug(`Optimized CSS. There were ${optimizationResult.actions.performed.length} optimizations performed.`);
    this.output.mkdirSync(path.dirname(cssFileName), {recursive: true});
    this.output.writeFileSync(cssFileName, optimizationResult.output.content.toString(), "utf8");
    this.output.writeFileSync(sourceMapFileName, optimizationResult.output.sourceMap?.toString(), "utf8");
    this.output.writeFileSync(optLogFileName, optimizationResult.actions.logStrings().join("\n"), "utf8");
    debug("Wrote css, sourcemap, and optimization log.");

    let dataGenerator = new RuntimeDataGenerator([...blocksUsed], optimizationResult.styleMapping, analyzer, config, reservedClassnames);
    let data = dataGenerator.generate();
    let serializedData = JSON.stringify(data, undefined, "  ");
    debug("CSS Blocks Data is: \n%s", serializedData);

    this.output.writeFileSync(
      `${this.appName}/services/-css-blocks-data.js`,
      `// CSS Blocks Generated Data. DO NOT EDIT.
       export const data = ${serializedData};
      `);
  }
}

/**
 * A plugin that is used during the CSS preprocess step to merge in the CSS Blocks optimized content
 * with application styles and the existing css tree.
 *
 * This plugin expects two broccoli nodes, in the following order...
 * 1) The result of the CSSBlocksApplicationPlugin.
 * 2) The css tree, passed in to `preprocessTree()`.
 *
 * The result of this plugin will be a file in app/styles/app.css that includes existing content appended
 * with the contents of css-blocks.css. This should be merged with the existing css tree to overwrite
 * the app.css file with this one.
 */
export class CSSBlocksStylesProcessorPlugin extends Plugin {
  async build() {
    // Read the optimized CSS Blocks styles file, generated previously by the CSSBlocksApplicationPlugin.
    // There should only be one css-blocks.css file.
    const blocksFileEntry = this.input.at(0).entries(".", {globs: ["**/css-blocks.css"]})[0];

    // And read the application CSS that was previously built by Ember and ignored by CSS Blocks.
    const blocksFileContents = this.input.at(0).readFileSync(blocksFileEntry.relativePath, { encoding: "utf8" });
    const appCssFileContents = this.input.at(1).readFileSync("app/styles/app.css", { encoding: "utf8" });

    // Now, write out the combined result of the application CSS and CSS Blocks contents.
    this.output.mkdirSync("app/styles", { recursive: true });
    this.output.writeFileSync("app/styles/app.css", `${appCssFileContents}${blocksFileContents}`);
  }
}
