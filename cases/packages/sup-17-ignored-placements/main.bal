import ballerina/scan;

type Holder record {|
    [@scan:Suppress {rules: ["ballerina:1"], reason: "Tuple member of a field"} int, string] pair;
|};

type Parser function () returns @scan:Suppress {rules: ["ballerina:1"], reason: "Function type"} int;

public function main() {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Destructured variable"}
    [int, int] [x, y] = [checkpanic int:fromString("1"), 2];
    Holder holder = {pair: [x + y, "z"]};
    Parser parser = () => holder.pair[0];
    _ = parser();
}

@scan:Suppress {reason: "Covers the declaration, not the members of the object"}
final object {} task = object {
    function run() returns int {
        int value = checkpanic int:fromString("1");
        return value;
    }
};

@scan:Suppress {reason: "Covers the type, not the members of the object"}
public type Runner readonly & object {
    public function run();
};
