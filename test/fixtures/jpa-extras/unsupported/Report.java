package extras.unsupported;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import org.hibernate.annotations.Subselect;

// Maps a query, not a table: Hibernate creates no table for it.
@Entity
@Subselect("select id, title from article")
public class Report {
  @Id private Long id;

  private String title;
}
