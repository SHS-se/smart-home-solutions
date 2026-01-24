import { useParams } from 'react-router-dom';
import Knowledge from '../Knowledge';
import EffektavgiftArticle from './EffektavgiftArticle';
import LastbalanseringArticle from './LastbalanseringArticle';

const ArticleRouter = () => {
  const { slug } = useParams();

  // Route to specific article pages
  switch (slug) {
    case 'effektavgift':
      return <EffektavgiftArticle />;
    case 'lastbalansering':
      return <LastbalanseringArticle />;
    case 'load-balancing':
      return <LastbalanseringArticle />;
    default:
      // For articles without dedicated pages, show the knowledge center
      return <Knowledge />;
  }
};

export default ArticleRouter;
