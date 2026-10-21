import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  Table,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'audit_log', timestamps: false, noPrimaryKey: true })
export class AuditLog extends Model<
  InferAttributes<AuditLog>,
  InferCreationAttributes<AuditLog>
> {
  @Attribute(DataTypes.TEXT)
  declare message: CreationOptional<string | null>;
}
