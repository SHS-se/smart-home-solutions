import { useParams } from 'react-router-dom';
import Knowledge from '../Knowledge';
import EffektavgiftArticle from './EffektavgiftArticle';

const ArticleRouter = () => {
  const { slug } = useParams();

  // Route to specific article pages
  switch (slug) {
    case 'effektavgift':
      return <EffektavgiftArticle />;
    default:
      // For articles without dedicated pages, show the knowledge center
      return <Knowledge />;
  }
};

export default ArticleRouter;
