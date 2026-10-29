package __JAVA_PACKAGE__;

import io.ballerina.compiler.syntax.tree.ModulePartNode;
import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.projects.Document;
import io.ballerina.projects.Module;
import io.ballerina.projects.plugins.AnalysisTask;
import io.ballerina.projects.plugins.CodeAnalysisContext;
import io.ballerina.projects.plugins.CodeAnalyzer;
import io.ballerina.projects.plugins.CompilerPlugin;
import io.ballerina.projects.plugins.CompilerPluginContext;
import io.ballerina.projects.plugins.SyntaxNodeAnalysisContext;
import io.ballerina.scan.Reporter;
import io.ballerina.scan.ScannerContext;

/**
 * Mirrors the upstream test analyzers: reports rule 1 once for every document of the package.
 */
public class StaticCodeAnalyzerPlugin extends CompilerPlugin {
    @Override
    public void init(CompilerPluginContext compilerPluginContext) {
        Object context = compilerPluginContext.userData().get("ScannerContext");
        if (context != null) {
            compilerPluginContext.addCodeAnalyzer(new Analyzer((ScannerContext) context));
        }
    }

    private static final class Analyzer extends CodeAnalyzer {
        private final ScannerContext scannerContext;

        Analyzer(ScannerContext scannerContext) {
            this.scannerContext = scannerContext;
        }

        @Override
        public void init(CodeAnalysisContext codeAnalysisContext) {
            codeAnalysisContext.addSyntaxNodeAnalysisTask(new Task(scannerContext.getReporter()), SyntaxKind.MODULE_PART);
        }
    }

    private static final class Task implements AnalysisTask<SyntaxNodeAnalysisContext> {
        private final Reporter reporter;

        Task(Reporter reporter) {
            this.reporter = reporter;
        }

        @Override
        public void perform(SyntaxNodeAnalysisContext context) {
            Module module = context.currentPackage().module(context.moduleId());
            Document document = module.document(context.documentId());
            ModulePartNode modulePartNode = (ModulePartNode) context.node();
            reporter.reportIssue(document, modulePartNode.location(), 1);
        }
    }
}
