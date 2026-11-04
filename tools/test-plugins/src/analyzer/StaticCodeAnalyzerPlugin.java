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
 * Documents named bug*.bal and vulnerability*.bal also report rule 2 and rule 3, and probe.bal prints
 * ScannerContext.isExcludeTests().
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
            codeAnalysisContext.addSyntaxNodeAnalysisTask(new Task(scannerContext), SyntaxKind.MODULE_PART);
        }
    }

    private static final class Task implements AnalysisTask<SyntaxNodeAnalysisContext> {
        private final ScannerContext scannerContext;
        private final Reporter reporter;

        Task(ScannerContext scannerContext) {
            this.scannerContext = scannerContext;
            this.reporter = scannerContext.getReporter();
        }

        @Override
        public void perform(SyntaxNodeAnalysisContext context) {
            Module module = context.currentPackage().module(context.moduleId());
            Document document = module.document(context.documentId());
            ModulePartNode modulePartNode = (ModulePartNode) context.node();
            reporter.reportIssue(document, modulePartNode.location(), 1);
            // Rules 2 (BUG) and 3 (VULNERABILITY) have no severity; only these documents report them.
            String name = document.name();
            if (name.startsWith("bug")) {
                reporter.reportIssue(document, modulePartNode.location(), 2);
            } else if (name.startsWith("vulnerability")) {
                reporter.reportIssue(document, modulePartNode.location(), 3);
            } else if (name.equals("probe.bal")) {
                System.out.println("[example analyzer] ScannerContext.isExcludeTests() = " + excludeTests());
            }
        }

        // Called reflectively so the plugin still compiles against scan-command JARs older than 0.13.0.
        private String excludeTests() {
            try {
                return String.valueOf(ScannerContext.class.getMethod("isExcludeTests").invoke(scannerContext));
            } catch (ReflectiveOperationException e) {
                return "not available (" + e.getClass().getSimpleName() + ")";
            }
        }
    }
}
