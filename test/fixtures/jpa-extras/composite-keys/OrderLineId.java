package extras.keys;

import java.io.Serializable;

/** The id class of OrderLine: not an entity. */
public class OrderLineId implements Serializable {
  private Long orderId;
  private Integer lineNo;
}
