/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ContainerRuntimeFactoryWithDefaultDataStore,
    DataObject,
    DataObjectFactory,
} from "@fluidframework/aqueduct";
import { IFluidHTMLView } from "@fluidframework/view-interfaces";
import { createDataStoreRegistry } from "@fluidframework/runtime-utils";

import React from "react";
import ReactDOM from "react-dom";
import ImageGallery from "react-image-gallery";
// eslint-disable-next-line import/no-internal-modules, import/no-unassigned-import
import "react-image-gallery/styles/css/image-gallery.css";
// eslint-disable-next-line import/no-unassigned-import
import "./Styles.css";
import { ISharedMap } from "@fluidframework/map";

const imageGalleryName = "@fluid-example/image-gallery";

export class ImageGalleryObject extends DataObject implements IFluidHTMLView {
    public get IFluidHTMLView() { return this; }

    imageList = [
        {
            original: "https://picsum.photos/800/800/?image=400",
            thumbnail: "https://picsum.photos/100/100/?image=400",
        },
        {
            original: "https://picsum.photos/800/800/?image=430",
            thumbnail: "https://picsum.photos/100/100/?image=430",
        },
        {
            original: "https://picsum.photos/800/800/?image=490",
            thumbnail: "https://picsum.photos/100/100/?image=490",
        },
        {
            original: "https://picsum.photos/800/800/?image=580",
            thumbnail: "https://picsum.photos/100/100/?image=580",
        },
        {
            original: "https://picsum.photos/800/800/?image=700",
            thumbnail: "https://picsum.photos/100/100/?image=700",
        },
    ];

    defaultProps = {
        items: [],
        showNav: true,
        autoPlay: false,
        lazyLoad: false,
    };

    imageGallery: ImageGallery | undefined;
    images: ISharedMap | undefined;

    private readonly onSlide = (index) => {
        this.root.set("position", index);
    };

    private readonly reactRender = (div, onSlide = this.onSlide) => {
        ReactDOM.render(
            <ImageGallery
                // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
                ref={(gallery) => (this.imageGallery = gallery ?? undefined)}
                items={this.imageList}
                onSlide={onSlide}
                slideDuration={10}
            />,
            div,
        );
    };
    protected async initializingFirstTime() {
        this.root.set("position", 0);
    }

    public render(div: HTMLDivElement) {
        div.className = "app-sandbox";

        this.reactRender(div);
        if (this.imageGallery !== undefined) {
            this.imageGallery.slideToIndex(this.root.get("position"));
        }

        this.root.on("valueChanged", (_, local) => {
            if (local) {
                return;
            }
            const position = this.root.get<number>("position");
            if (this.imageGallery !== undefined) {
                // This is a result of a remote slide, don't trigger onSlide for this slide
                this.reactRender(div, () => this.reactRender(div));
                this.imageGallery.slideToIndex(position);
            }
        });
    }
}

export const ImageGalleryInstantiationFactory = new DataObjectFactory(
    imageGalleryName,
    ImageGalleryObject,
    [],
    {},
);

export const fluidExport = new ContainerRuntimeFactoryWithDefaultDataStore(
    ImageGalleryInstantiationFactory,
    createDataStoreRegistry([
        [imageGalleryName, Promise.resolve(ImageGalleryInstantiationFactory)],
    ]),
);
