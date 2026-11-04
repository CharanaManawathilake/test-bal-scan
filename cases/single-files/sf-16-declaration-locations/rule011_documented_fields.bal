// Class A5 of upstream rule011_unused_class_fields.bal, the part about doc comments and annotations.
// The upstream file has isolated classes with mutable fields, which do not compile, so a real scan skips it.
type FieldMeta record {|
    string note;
|};

annotation FieldMeta Info on field;

class A5 {
    # Documented field
    private string b = ""; // ballerina:11
    @Info {note: "annotated"}
    private final string c = ""; // ballerina:11
    # Documented and annotated field
    @Info {note: "annotated"}
    private int d = 0; // ballerina:11
}

public function main() {
    A5 a = new;
    _ = a;
}
