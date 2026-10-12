import {
  DataTypes,
  Model,
  Sequelize,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from 'sequelize';

export class Document extends Model<
  InferAttributes<Document>,
  InferCreationAttributes<Document>
> {
  declare id: string;
  declare ulid: string;
  declare short: string;
  declare uid: CreationOptional<string>;
  declare token: CreationOptional<string>;
  declare title: string;
  declare body: string;
  declare role: CreationOptional<'admin' | 'user'>;
  declare small: number;
  declare ratio: number;
  declare price: string;
  declare cost: string;
  declare views: string;
  declare blob: Buffer;
  declare meta: unknown;
  declare readonly created: CreationOptional<Date>;
  declare readonly updated: CreationOptional<Date>;
  declare day: string;
  declare at: string;
  declare ip: string;
  declare internal: number;
  declare legacy: string;

  static initModel(sequelize: Sequelize): typeof Document {
    Document.init(
      {
        id: { type: DataTypes.STRING, primaryKey: true },
        ulid: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: 'uq_document_ulid',
        },
        short: { type: DataTypes.TEXT, allowNull: false },
        uid: {
          type: DataTypes.UUID,
          allowNull: false,
          defaultValue: DataTypes.UUIDV4,
        },
        token: {
          type: DataTypes.UUID,
          allowNull: false,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
        },
        title: { type: DataTypes.STRING, allowNull: false },
        body: { type: DataTypes.TEXT, allowNull: false },
        role: {
          type: DataTypes.ENUM('admin', 'user'),
          allowNull: false,
          defaultValue: 'user',
        },
        small: { type: DataTypes.INTEGER, allowNull: false },
        ratio: { type: DataTypes.DOUBLE, allowNull: false },
        price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
        cost: { type: DataTypes.DECIMAL, allowNull: false },
        views: { type: DataTypes.BIGINT, allowNull: false },
        blob: { type: DataTypes.BLOB, allowNull: false },
        meta: { type: DataTypes.JSONB, allowNull: false },
        created: { type: DataTypes.DATE, allowNull: false },
        updated: { type: DataTypes.DATE, allowNull: false },
        day: { type: DataTypes.DATEONLY, allowNull: false },
        at: { type: DataTypes.TIME, allowNull: false },
        ip: { type: DataTypes.INET, allowNull: false },
        internal: { type: DataTypes.INTEGER, allowNull: false },
        legacy: {
          type: DataTypes.TEXT,
          allowNull: false,
          field: 'legacy_name',
        },
      },
      {
        sequelize,
        modelName: 'Document',
        tableName: 'document',
        schema: 'audit',
        timestamps: true,
        createdAt: 'created',
        updatedAt: 'updated',
        underscored: true,
        indexes: [
          {
            name: 'ix_document_title',
            using: 'BTREE',
            fields: [{ name: 'title', order: 'DESC' }, 'created'],
          },
          { using: 'GIN', fields: [{ name: 'meta', operator: 'JsonbPathOps' }] },
          { name: 'uq_document_title_day', unique: true, fields: ['title', 'day'] },
        ],
      }
    );
    return Document;
  }
}
