fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["contracts"] {
        println!("{}", ranking_contracts::model::metadata());
        return;
    }
    eprintln!("usage: ranking-refresh contracts (Node remains the default refresh worker)");
    std::process::exit(2);
}
