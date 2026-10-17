package extras.keys;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Course {
  @Id private Long id;

  private String title;
}
