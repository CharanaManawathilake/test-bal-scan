import ballerina/scan;

public function main() {
    @scan:Suppress {reason: "Blanket"}
    @scan:Suppress {rules: ["ballerina:1"], reason: "Rule-specific"}
    int blanketFirst = checkpanic int:fromString("1");
    _ = blanketFirst;

    @scan:Suppress {rules: ["ballerina:1"], reason: "Rule-specific"}
    @scan:Suppress {reason: "Blanket"}
    int blanketLast = checkpanic int:fromString("2");
    _ = blanketLast;

    @scan:Suppress {rules: ["ballerina:1"], reason: "First"}
    @scan:Suppress {rules: ["ballerina:1"]}
    int duplicate = checkpanic int:fromString("3");
    _ = duplicate;

    @scan:Suppress {reason: "First"}
    @scan:Suppress {reason: "Every rule again"}
    int twice = checkpanic int:fromString("4");
    _ = twice;
}
