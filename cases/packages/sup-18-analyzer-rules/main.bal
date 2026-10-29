import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["exampleOrg/example_module_static_code_analyzer:1"], reason: "Defined by the analyzer"}
    int known = 1;
    @scan:Suppress {rules: ["exampleOrg/example_module_static_code_analyzer:99"], reason: "Not defined"}
    int unknown = 2;
    _ = known + unknown;
}
