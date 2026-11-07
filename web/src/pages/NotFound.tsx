import { Link } from "react-router";
import { ArrowRight } from "../components/Icons.tsx";

export function NotFound({ what = "page" }: { what?: string }) {
  return (
    <div className="container not-found">
      <span className="eyebrow">404</span>
      <h1 className="page-title">This {what} didn't <span className="serif">clear the bar</span>.</h1>
      <p className="page-lede">It doesn't exist, or it isn't on this network.</p>
      <div className="row">
        <Link to="/challenges" className="btn btn-primary">Browse challenges <ArrowRight /></Link>
        <Link to="/" className="btn">Home</Link>
      </div>
    </div>
  );
}
